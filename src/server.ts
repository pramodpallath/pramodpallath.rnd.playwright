import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { FlowStore, ConflictError } from './store.js';
import { Runner } from './runner.js';
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
  app.post('/api/flows/:id/run', async (req, res) => {
    const body = z.object({ inputs: z.record(z.string(), z.string()).default({}), repairStep: idSchema.optional() }).strict().parse(req.body);
    const id = idSchema.parse(req.params.id);
    await store.read(id);
    res.status(202).json(runner.start(id, body).view);
  });
  app.get('/api/runs', (_req, res) => res.json([...runner.runs.values()].map(run => run.view)));
  app.get('/api/runs/:id', (req, res) => {
    const run = runner.runs.get(req.params.id as string);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run.view);
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
