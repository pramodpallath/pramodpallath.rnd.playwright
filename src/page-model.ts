import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Page } from 'playwright';
import { observe } from './browser.js';
import { locatorSchema, idSchema } from './schema.js';

const controlSchema = z.object({
  id: idSchema,
  label: z.string(),
  tag: z.string(),
  locator: locatorSchema,
  capabilities: z.array(z.enum(['click', 'fill', 'select', 'check', 'read'])),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
});
export const pageModelSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  url: z.string().url(),
  title: z.string(),
  headings: z.array(z.string()),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  discoveredAt: z.string(),
  controls: z.array(controlSchema),
});
export type PageModel = z.infer<typeof pageModelSchema>;

function capabilities(tag: string, target: z.infer<typeof locatorSchema>['target'], options?: unknown): PageModel['controls'][number]['capabilities'] {
  const role = target.by === 'role' ? target.role : undefined;
  if (tag === 'select' || options) return ['select', 'read'];
  if (tag === 'textarea' || tag === 'input' && !['checkbox', 'radio', 'button'].includes(role ?? '')) return ['fill', 'read'];
  if (role === 'checkbox' || role === 'radio') return ['check', 'read'];
  if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link') return ['click', 'read'];
  return ['read'];
}

/** The inventory is browser-grounded; no LLM-generated selector is trusted. */
export async function discoverPageModel(page: Page, id: string): Promise<PageModel> {
  idSchema.parse(id);
  const observation = await observe(page);
  const controls = observation.candidates.map((c, index) => ({
    id: `control-${index + 1}`,
    label: c.label,
    tag: c.tag,
    locator: c.locator,
    capabilities: capabilities(c.tag, c.locator.target, c.options),
    ...(c.options ? { options: c.options } : {}),
  }));
  const fingerprint = createHash('sha256').update(JSON.stringify({
    url: observation.url, headings: observation.headings,
    controls: controls.map(c => ({ label: c.label, tag: c.tag, locator: c.locator })),
  })).digest('hex');
  return pageModelSchema.parse({
    schemaVersion: 1, id, url: observation.url, title: observation.title,
    headings: observation.headings, controls, fingerprint, discoveredAt: new Date().toISOString(),
  });
}

/** Atomic, validated local storage; only canonical IDs can form filenames. */
export class PageModelStore {
  constructor(private readonly directory: string) {}
  async save(model: PageModel): Promise<PageModel> {
    const validated = pageModelSchema.parse(model);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, `${validated.id}.json`);
    const temporary = path.join(this.directory, `.${validated.id}-${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(validated, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return validated;
  }
  async read(id: string): Promise<PageModel> {
    return pageModelSchema.parse(JSON.parse(await readFile(path.join(this.directory, `${idSchema.parse(id)}.json`), 'utf8')));
  }
  async list(): Promise<PageModel[]> {
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return Promise.all(files.filter(f => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(f)).map(f => this.read(f.slice(0, -5))));
  }
}
