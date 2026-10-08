import express from 'express';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { parseDocument } from 'yaml';
import { FlowStore, ConflictError } from './store.js';
import { Runner, type RunView } from './runner.js';
import { idSchema, urlSchema } from './schema.js';

export function createApp(store: FlowStore, runner: Runner) {
  const app = express();
  const token = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host = req.headers.host?.split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host ?? '')) return res.status(403).json({ error: 'Localhost access only' });
    const origin = req.headers.origin;
    if (origin && ![`http://${req.headers.host}`].includes(origin)) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
    if (req.path.startsWith('/api/') && req.method !== 'GET') {
      const supplied = Buffer.from(req.headers['x-flow-token']?.toString() ?? '');
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(403).json({ error: 'Invalid local session token' });
    }
    next();
  });
  app.get('/api/session', (_req, res) => res.json({ token }));
  app.get('/api/flows', async (_req, res) => res.json(await store.list()));
  app.post('/api/flows', async (req, res) => {
    const body = z.object({ id: idSchema, name: z.string().min(1), url: urlSchema }).strict().parse(req.body);
    res.status(201).json(await store.create(body.id, body.name, body.url));
  });
  app.get('/api/flows/:id', async (req, res) => res.json(await store.read(req.params.id as string)));
  app.put('/api/flows/:id', async (req, res) => {
    const body = z.object({ source: z.string(), revision: z.string() }).strict().parse(req.body);
    res.json(await store.save(req.params.id as string, body.source, body.revision));
  });
  app.post('/api/flows/:id/steps', async (req, res) => {
    const body = z.object({ source: z.string(), revision: z.string(), id: idSchema, instruction: z.string().trim().min(1).max(4000) }).strict().parse(req.body);
    const document = parseDocument(body.source);
    if (document.errors.length) throw new Error(document.errors[0].message);
    document.addIn(['steps'], { id: body.id, instruction: body.instruction });
    res.json(await store.save(req.params.id as string, document.toString(), body.revision));
  });
  app.post('/api/flows/:id/run', async (req, res) => {
    const body = z.object({ inputs: z.record(z.string(), z.string()).default({}), repairStep: idSchema.optional() }).strict().parse(req.body);
    const id = idSchema.parse(req.params.id);
    const { flow } = await store.read(id);
    const missing = Object.entries(flow.inputs).filter(([name, definition]) => definition.required && (!Object.hasOwn(body.inputs, name) || body.inputs[name] === '')).map(([name]) => name);
    if (missing.length) throw new Error(`Fill required inputs before running: ${missing.join(', ')}`);
    res.status(202).json(runner.start(id, body).view);
  });
  const runId = z.union([z.string().regex(/^\d{16,20}$/), z.string().uuid()]);
  const runDirectory = (id: string) => path.join(runner.dataDir, 'runs', runId.parse(id));
  app.get('/api/runs', async (_req, res) => {
    const views = new Map([...runner.runs.values()].map(run => [run.view.id, run.view]));
    const entries = await readdir(path.join(runner.dataDir, 'runs'), { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !runId.safeParse(entry.name).success || views.has(entry.name)) continue;
      try { views.set(entry.name, JSON.parse(await readFile(path.join(runDirectory(entry.name), 'run.json'), 'utf8'))); }
      catch { /* Ignore incomplete records; live runs remain available. */ }
    }
    res.json([...views.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  });
  app.get('/api/runs/:id/llm-log', async (req, res) => {
    const directory = runDirectory(req.params.id as string);
    const run: RunView = runner.runs.get(req.params.id as string)?.view ?? JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    if (run.llmLogs?.length) return res.json(run.llmLogs);
    res.sendFile(path.join(directory, 'llm.jsonl'));
  });
  app.get('/api/runs/:id/llm-logs/:file', (req, res) => {
    const directory = runDirectory(req.params.id as string);
    const file = z.string().regex(/^(?:\d{16,20}-llm-[a-z0-9_-]+|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-\d{6,}-llm-[a-z0-9_-]+)\.json$/i).parse(req.params.file);
    res.sendFile(path.join(directory, file));
  });
  app.get('/api/runs/:id/log', async (req, res) => {
    const id = runId.parse(req.params.id);
    const directory = runDirectory(id);
    const run: RunView = runner.runs.get(id)?.view ?? JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    res.sendFile(path.join(runner.dataDir, 'runs', run.logFile ?? `${id}.jsonl`));
  });
  app.get('/api/runs/:id/screenshots/:file', (req, res) => {
    const directory = runDirectory(req.params.id as string);
    const file = z.string().regex(/^\d+-[a-z0-9_-]+-(before|after|paused|failed)\.png$/).parse(req.params.file);
    res.sendFile(path.join(directory, file));
  });
  app.get('/api/runs/:id', async (req, res) => {
    const directory = runDirectory(req.params.id as string);
    const run = runner.runs.get(req.params.id as string);
    res.json(run?.view ?? JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')));
  });
  app.post('/api/runs/:id/respond', (req, res) => {
    const body = z.object({ decision: z.enum(['continue', 'retry', 'done', 'stop']), value: z.string().optional() }).strict().parse(req.body);
    const run = runner.runs.get(req.params.id as string);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    run.respond(body.decision, body.value);
    res.json(run.view);
  });
  app.post('/api/runs/:id/stop', async (req, res) => {
    const run = runner.runs.get(req.params.id as string);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    await run.stop(); res.json(run.view);
  });
  app.use(express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error instanceof ConflictError ? 409 : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Request failed' });
  });
  return app;
}
