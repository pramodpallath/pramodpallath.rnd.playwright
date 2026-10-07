import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { chromium } from 'playwright';
import { FlowStore, ConflictError } from '../src/store.js';
import { Runner, type Run } from '../src/runner.js';
import { createApp } from '../src/server.js';
import { observe } from '../src/browser.js';
import type { Plan } from '../src/schema.js';

let server: Server, url: string, root: string;
const description = { target: { by: 'label' as const, value: 'Description', exact: true } };
const plan: Plan = { actions: [
  { type: 'fill', locator: description, value: '{Desc}' },
  { type: 'extract', locator: description, source: 'value', output: 'description' },
], expect: [{ kind: 'value', locator: description, value: '{Desc}' }] };

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'flow-tests-'));
  server = createServer((req, res) => {
    const html = '<!doctype html><title>Fixture</title><h1>Requisition</h1><label>Description<input id="desc"></label><label>Password<input type="password" id="password"></label><button id="create">Create</button><script>localStorage.setItem("visits",String(Number(localStorage.getItem("visits")||0)+1))</script>';
    if (req.url === '/slow') { setTimeout(() => { res.end(html); }, 1000); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

async function setup(name: string, executionPlan?: Plan) {
  const directory = path.join(root, name);
  const store = new FlowStore(path.join(directory, 'flows'));
  await store.save(name, stringify({ version: 1, id: name, name, url, profile: name, inputs: { Desc: { required: true } }, steps: [{ id: 'description', instruction: 'Fill Description with {Desc}', timeoutMs: 300, ...(executionPlan ? { plan: executionPlan } : {}) }] }), null);
  return { store, directory };
}
async function until(predicate: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for run state'); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function complete(run: Run) {
  await Promise.race([run.finished, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Run did not finish')), 15000); timer.unref(); })]);
  assert.equal(run.view.status, 'completed', JSON.stringify(run.view.events));
}

test('saved plans execute in Chromium with zero resolver calls', async () => {
  const { store, directory } = await setup('saved', plan);
  let calls = 0;
  const runner = new Runner(store, directory, async () => { calls++; throw new Error('Must not resolve'); });
  const run = runner.start('saved', { headless: true, inputs: { Desc: 'Office supplies' } });
  await complete(run);
  assert.equal(calls, 0);
  assert.equal(run.view.outputs.description, 'Office supplies');
  assert.ok(!(await readFile(path.join(directory, 'runs', `${run.view.id}.jsonl`), 'utf8')).includes('Office supplies'));
});

test('missing plan is learned and persisted; subsequent replay bypasses resolver', async () => {
  const { store, directory } = await setup('learn');
  let calls = 0;
  const runner = new Runner(store, directory, async () => { calls++; return plan; });
  await complete(runner.start('learn', { headless: true, inputs: { Desc: 'First' } }));
  assert.equal((await store.read('learn')).flow.steps[0].learned?.status, 'verified');
  await complete(runner.start('learn', { headless: true, inputs: { Desc: 'Second' } }));
  assert.equal(calls, 1);
});

test('explicit repair invokes resolver even with an existing plan', async () => {
  const { store, directory } = await setup('repair', plan);
  let calls = 0;
  const runner = new Runner(store, directory, async () => { calls++; return plan; });
  await complete(runner.start('repair', { repairStep: 'description', headless: true, inputs: { Desc: 'Repaired' } }));
  assert.equal(calls, 1);
});

test('broken saved selector pauses without invoking resolver', async () => {
  const { store, directory } = await setup('broken', { actions: [{ type: 'click', locator: { target: { by: 'css', value: '#missing' } } }], expect: [] });
  let calls = 0;
  const runner = new Runner(store, directory, async () => { calls++; return plan; });
  const run = runner.start('broken', { headless: true, inputs: { Desc: 'x' } });
  await until(() => !!run.view.pause);
  assert.equal(run.view.pause?.kind, 'before-action');
  assert.equal(calls, 0);
  await run.stop(); await run.finished; assert.equal(run.view.status, 'stopped');
});

test('navigation timeout after dispatch offers no automatic retry', async () => {
  const { store, directory } = await setup('uncertain', { actions: [{ type: 'navigate', url: `${url}/slow` }], expect: [] });
  const runner = new Runner(store, directory);
  const run = runner.start('uncertain', { headless: true, inputs: { Desc: 'x' } });
  await until(() => !!run.view.pause);
  assert.equal(run.view.pause?.kind, 'uncertain');
  assert.deepEqual(run.view.pause?.choices, ['done', 'stop']);
  await run.stop(); await run.finished;
});

test('password fill is blocked and manual browser handoff resumes', async () => {
  const { store, directory } = await setup('manual', { actions: [
    { type: 'ask-user', mode: 'browser', prompt: 'Complete sign-in manually.' },
    { type: 'fill', locator: { target: { by: 'css', value: '#password' } }, value: '{Desc}' },
  ], expect: [] });
  const run = new Runner(store, directory).start('manual', { headless: true, inputs: { Desc: 'not-stored' } });
  await until(() => run.view.pause?.kind === 'manual');
  run.respond('continue');
  await until(() => run.view.pause?.kind === 'before-action');
  await run.stop(); await run.finished;
});

test('instruction edits invalidate plans; stale saves are rejected; comments survive learning', async () => {
  const { store } = await setup('editing', plan);
  const old = await store.read('editing');
  const commented = await store.save('editing', '# Keep this comment\n' + old.source, old.revision);
  const learned = await store.learn('editing', 'description', plan, 'candidate', commented.revision);
  assert.ok(learned.source.startsWith('# Keep this comment'));
  const edited = await store.save('editing', learned.source.replace('Fill Description with {Desc}', 'Click Create instead'), learned.revision);
  assert.equal(edited.flow.steps[0].plan, undefined);
  assert.equal(edited.flow.steps[0].learned, undefined);
  await assert.rejects(store.save('editing', old.source, old.revision), ConflictError);
});

test('persistent profile retains local storage across runs and excludes sensitive observations', async () => {
  const { store, directory } = await setup('persistent', plan);
  const runner = new Runner(store, directory);
  await complete(runner.start('persistent', { headless: true, inputs: { Desc: 'x' } }));
  const browser = await chromium.launchPersistentContext(path.join(directory, 'profiles', 'persistent'), { headless: true });
  try {
    const page = browser.pages()[0]; await page.goto(url);
    assert.equal(await page.evaluate(() => localStorage.getItem('visits')), '2');
    const observation = await observe(page);
    assert.ok(observation.candidates.some(c => c.label === 'Description'));
    assert.ok(!JSON.stringify(observation).includes('Password'));
  } finally { await browser.close(); }
});

test('local API requires a session token for mutations and rejects cross-origin requests', async () => {
  const store = new FlowStore(path.join(root, 'api-flows'));
  const runner = new Runner(store, path.join(root, 'api-data'));
  const appServer = createApp(store, runner).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => appServer.once('listening', resolve));
  const address = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
  try {
    const body = JSON.stringify({ id: 'api-flow', name: 'API flow', url });
    assert.equal((await fetch(`${address}/api/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
    const { token } = await (await fetch(`${address}/api/session`)).json() as { token: string };
    assert.equal((await fetch(`${address}/api/flows`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Flow-Token': token }, body })).status, 201);
    assert.equal((await fetch(`${address}/api/flows`, { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  } finally { await new Promise<void>(resolve => appServer.close(() => resolve())); }
});
