import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { flowSchema, idSchema, instructionInputs, type Flow, type Plan } from './schema.js';

export class ConflictError extends Error {}
export const revision = (source: string) => createHash('sha256').update(source).digest('hex');

export class FlowStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private file(id: string) { return path.join(this.directory, `${idSchema.parse(id)}.yaml`); }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async list() {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(f => f.endsWith('.yaml'));
    return Promise.all(files.map(async file => {
      const id = file.slice(0, -5);
      try { const { flow } = await this.read(id); return { id, name: flow.name, url: flow.url, steps: flow.steps.length }; }
      catch { return { id, name: id, error: 'Invalid YAML flow' }; }
    }));
  }
  async read(id: string) {
    const source = await readFile(this.file(id), 'utf8');
    const document = parseDocument(source);
    if (document.errors.length) throw new Error(document.errors[0].message);
    const flow = flowSchema.parse(document.toJS());
    flow.inputs = instructionInputs(flow);
    if (flow.id !== id) throw new Error('Flow ID must match its filename');
    return { flow, source, revision: revision(source) };
  }
  async save(id: string, source: string, expected: string | null) {
    return this.exclusive(async () => {
      const document = parseDocument(source);
      if (document.errors.length) throw new Error(document.errors[0].message);
      const flow = flowSchema.parse(document.toJS());
      if (flow.id !== id) throw new Error('Flow ID cannot change');
      let previous: Awaited<ReturnType<FlowStore['read']>> | undefined;
      try { previous = await this.read(id); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if ((previous?.revision ?? null) !== expected) throw new ConflictError('Flow changed; reload before saving');
      for (const [name, definition] of Object.entries(instructionInputs(flow))) {
        if (!Object.hasOwn(flow.inputs, name)) document.setIn(['inputs', name], definition);
      }
      // An edited instruction must never silently reuse the previous learned actions.
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        const old = previous?.flow.steps.find(s => s.id === step.id);
        if (old && old.instruction !== step.instruction) {
          document.deleteIn(['steps', i, 'plan']);
          document.deleteIn(['steps', i, 'learned']);
        }
      }
      await this.atomic(id, document.toString());
      return this.read(id);
    });
  }
  async create(id: string, name: string, url: string) {
    return this.save(id, stringify({ version: 1, id, name, url, profile: 'default', inputs: {}, steps: [{ id: 'step-1', instruction: 'Describe your first action here' }] }), null);
  }
  async learn(id: string, stepId: string, plan: Plan, status: 'candidate' | 'verified', expected: string) {
    return this.exclusive(async () => {
      const current = await this.read(id);
      if (current.revision !== expected) throw new ConflictError('Flow edited during run; learned plan was not written');
      const index = current.flow.steps.findIndex(s => s.id === stepId);
      if (index < 0) throw new ConflictError('Step was removed');
      const document = parseDocument(current.source);
      document.setIn(['steps', index, 'plan'], plan);
      document.setIn(['steps', index, 'learned'], { status, at: new Date().toISOString() });
      await this.atomic(id, document.toString());
      return this.read(id);
    });
  }
  private async atomic(id: string, source: string) {
    await mkdir(this.directory, { recursive: true });
    const temp = `${this.file(id)}.${randomUUID()}.tmp`;
    try { await writeFile(temp, source, { mode: 0o600 }); await rename(temp, this.file(id)); }
    finally { await unlink(temp).catch(() => {}); }
  }
}
