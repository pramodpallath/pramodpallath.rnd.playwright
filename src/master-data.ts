import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const masterDataSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  sourceWorkflow: z.string().min(1),
  capturedAt: z.string().datetime(),
  complete: z.boolean(),
  pagesVisited: z.number().int().min(1),
  keyColumn: z.string().min(1),
  labelColumn: z.string().min(1),
  records: z.array(z.object({ value: z.string(), label: z.string() }).strict()),
}).strict();
export type MasterDataSet = z.infer<typeof masterDataSchema>;

/**
 * Stores reference data independently of workflow outputs.
 * Incomplete extractions cannot silently replace a complete dataset.
 */
export class MasterDataRegistry {
  constructor(private readonly directory: string) {}

  private filename(id: string): string {
    const valid = masterDataSchema.shape.id.parse(id);
    return path.join(this.directory, `${valid}.json`);
  }

  async read(id: string): Promise<MasterDataSet> {
    return masterDataSchema.parse(JSON.parse(await readFile(this.filename(id), 'utf8')));
  }

  async save(dataset: MasterDataSet): Promise<void> {
    const valid = masterDataSchema.parse(dataset);
    const keys = valid.records.map(record => record.value);
    if (keys.some(key => !key.trim()) || new Set(keys).size !== keys.length)
      throw new Error('Master data values must be non-empty and unique');
    const previous = await this.read(valid.id).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (previous?.complete && !valid.complete)
      throw new Error('Cannot replace complete master data with incomplete extraction');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.filename(valid.id);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(valid, null, 2), { mode: 0o600 });
    await rename(temporary, filename);
  }

  async resolve(id: string, label: string): Promise<string> {
    const dataset = await this.read(id);
    const matches = dataset.records.filter(record => record.label === label);
    if (matches.length !== 1) throw new Error('Master data label is missing or ambiguous');
    return matches[0].value;
  }
}
