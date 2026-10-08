import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { chromium, type Page } from 'playwright';
import { resolvePlan } from '../src/planner.js';
import { FlowStore } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { flowSchema, planSchema, type Plan } from '../src/schema.js';

let server: Server, url: string, root: string;
const ready = { target: { by: 'role' as const, role: 'heading' as const, name: 'Portal ready', exact: true } };
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sso-tests-'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/azure-app') res.end('<h1>Welcome back, Test User!</h1>');
    else if (req.url === '/app') res.end('<h1>Portal ready</h1>');
    else if (req.url === '/slow-sso') res.end('<h1>Sign in</h1><script>setTimeout(()=>location.href="/app",1800)</script>');
    else if (req.url === '/silent') res.end('<h1>Redirecting</h1><script>setTimeout(()=>location.href="/app",250)</script>');
    else if (req.url === '/auth') res.end('<button onclick="localStorage.setItem(\'signed-in\',\'yes\');opener.location.href=\'/app\';window.close()">Finish login</button>');
    else res.end('<h1>Sign in</h1><button onclick="window.open(\'/auth\')">Login</button><script>if(localStorage.getItem("signed-in"))location.href="/app"</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Run state timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function setup(name: string, route: string, graceMs = 0, timeoutMs = 5000) {
  const directory = path.join(root, name);
  const store = new FlowStore(path.join(directory, 'flows'));
  const plan: Plan = { actions: [{ type: 'ask-user', mode: 'browser', prompt: 'Complete SSO in the browser.', graceMs,
    until: [{ kind: 'origin', value: url }, { kind: 'visible', locator: ready }] }], expect: [] };
  await store.save(name, stringify({ version: 1, id: name, name, url: url + route, profile: name, steps: [
    { id: 'sso', instruction: 'Complete SSO', timeoutMs },
    { id: 'next', instruction: 'Read portal heading', plan: { actions: [{ type: 'extract', locator: ready, output: 'next', source: 'text' }], expect: [] } },
  ] }), null);
  let page: Page | undefined, calls = 0;
  const runner = new Runner(store, directory, async active => { page = active; calls++; return plan; });
  return { runner, store, directory, plan, page: () => page!, calls: () => calls };
}

test('conditional prompts validate browser mode, nonempty conditions and grace dependency', () => {
  const action = { type: 'ask-user', mode: 'input', prompt: 'Input', input: 'name', until: [{ kind: 'origin', value: 'https://example.com' }] };
  assert.equal(planSchema.safeParse({ actions: [action] }).success, false);
  assert.equal(planSchema.safeParse({ actions: [{ ...action, mode: 'browser', until: [] }] }).success, false);
  assert.equal(planSchema.safeParse({ actions: [{ type: 'ask-user', mode: 'browser', prompt: 'Login', graceMs: 10 }] }).success, false);
});

test('already signed-in application skips manual pause and runs next step', async () => {
  const { runner } = await setup('already', '/app');
  const run = runner.start('already', { headless: true });
  await run.finished;
  assert.equal(run.view.status, 'completed');
  assert.equal(run.view.outputs.next, 'Portal ready');
  assert.ok(!run.view.events.some(e => e.message.startsWith('Paused:')));
});

test('silent SSO redirect completes during grace without a prompt', async () => {
  const { runner } = await setup('silent', '/silent', 2000);
  const run = runner.start('silent', { headless: true });
  await run.finished;
  assert.equal(run.view.status, 'completed');
  assert.ok(!run.view.events.some(e => e.message.startsWith('Paused:')));
});

test('login popup resumes automatically on its application page and saved session replays without resolver', async () => {
  const fixture = await setup('popup-sso', '/entry');
  const run = fixture.runner.start('popup-sso', { headless: true });
  try {
    await waitFor(() => run.view.status === 'paused');
    const page = fixture.page();
    const opened = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    const popup = await opened;
    await popup.getByRole('button', { name: 'Finish login', exact: true }).click();
    await run.finished;
    assert.equal(run.view.status, 'completed');
    assert.equal(run.view.outputs.next, 'Portal ready');
    const replay = fixture.runner.start('popup-sso', { headless: true });
    await replay.finished;
    assert.equal(replay.view.status, 'completed');
    assert.ok(!replay.view.events.some(e => e.message.startsWith('Paused:')));
    assert.equal(fixture.calls(), 1);
  } finally { await run.stop(); await run.finished; }
});

test('Continue cannot bypass login; timeout retries verification and then resumes', async () => {
  const fixture = await setup('timeout-sso', '/entry', 0, 1200);
  const run = fixture.runner.start('timeout-sso', { headless: true });
  try {
    await waitFor(() => run.view.pause?.kind === 'manual');
    const pause = run.view.pause;
    run.respond('continue');
    await waitFor(() => run.view.pause?.kind === 'manual' && run.view.pause !== pause);
    assert.equal(run.view.outputs.next, undefined);
    await waitFor(() => run.view.pause?.kind === 'verify');
    assert.deepEqual(run.view.pause?.choices, ['retry', 'stop']);
    assert.equal(run.view.outputs.next, undefined);
    await fixture.page().goto(url + '/app');
    run.respond('retry');
    await run.finished;
    assert.equal(run.view.status, 'completed');
    assert.equal(run.view.outputs.next, 'Portal ready');
  } finally { await run.stop(); await run.finished; }
});

test('Stop cancels conditional monitoring without executing the next step', async () => {
  const { runner } = await setup('stop-sso', '/entry');
  const run = runner.start('stop-sso', { headless: true });
  await waitFor(() => run.view.status === 'paused');
  await run.stop(); await run.finished;
  assert.equal(run.view.status, 'stopped');
  assert.equal(run.view.outputs.next, undefined);
  assert.equal(run.view.pause, undefined);
});


test('login popup left open does not steal the next application step', async () => {
  const fixture = await setup('open-popup-sso', '/entry');
  const run = fixture.runner.start('open-popup-sso', { headless: true });
  try {
    await waitFor(() => run.view.status === 'paused');
    const page = fixture.page();
    const opened = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    const popup = await opened;
    await popup.waitForLoadState();
    await page.goto(url + '/app');
    await run.finished;
    assert.equal(run.view.status, 'completed', JSON.stringify(run.view.events));
    assert.equal(run.view.outputs.next, 'Portal ready');
  } finally { await run.stop(); await run.finished; }
});

test('CLI cancels its manual question when SSO completes without terminal input', async () => {
  const fixture = await setup('cli-sso', '/slow-sso', 0);
  const loaded = await fixture.store.read('cli-sso');
  await fixture.store.learn('cli-sso', 'sso', fixture.plan, 'verified', loaded.revision);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'run', 'cli-sso', '--headless'], {
    env: { ...process.env, FLOW_DIR: path.join(fixture.directory, 'flows'), DATA_DIR: fixture.directory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await Promise.race([exited, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI timed out: ${output}`)), 10000); timer.unref();
    })]);
    assert.equal(child.exitCode, 0, output);
    assert.match(output, /Choose continue \/ stop/);
    assert.match(output, /Result: completed/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});


test('planner compiles observed SSO completion conditions into a replayable action', async () => {
  const fixture = await setup('planner-sso', '/app');
  const browser = await chromium.launch({ headless: true });
  const originalFetch = globalThis.fetch;
  const key = process.env.OPENROUTER_API_KEY, model = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = 'fixture-key'; process.env.OPENROUTER_MODEL = 'fixture-model';
  try {
    const page = await browser.newPage();
    await page.goto(url + '/app');
    await page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Account'; document.body.append(button); });
    globalThis.fetch = async (input, init) => {
      if (input !== 'https://openrouter.ai/api/v1/chat/completions') return originalFetch(input, init);
      const request = JSON.parse(String(init?.body));
      const observation = JSON.parse(request.messages[1].content).observation;
      const account = observation.candidates.find((candidate: { label: string }) => candidate.label === 'Account');
      assert.ok(account);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: [{
        type: 'ask-user', mode: 'browser', prompt: 'Complete sign-in.', input: null, candidate: null,
        value: null, url: null, checked: null, output: null, source: null, condition: null,
        until: [{ kind: 'origin', candidate: null, value: url }, { kind: 'visible', candidate: account.id, value: null }],
      }], expect: [], unresolvedReason: null }) } }] }));
    };
    const flow = (await fixture.store.read('planner-sso')).flow;
    const compiled = await resolvePlan(page, flow.steps[0], flow);
    const action = compiled.actions[0];
    assert.equal(action.type, 'ask-user');
    assert.ok(action.type === 'ask-user' && action.until?.length === 2);
    assert.deepEqual(action.until?.[0], { kind: 'origin', value: url });
  } finally {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key;
    if (model === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = model;
    await browser.close();
  }
});


test('Azure YAML uses the supplied Welcome back marker and resumes without the LLM', async () => {
  const flow = flowSchema.parse(parse(await readFile('flows/azure-portal.yaml', 'utf8')));
  const action = flow.steps[0].plan!.actions[0];
  assert.ok(action.type === 'ask-user' && action.until);
  assert.equal(flow.steps[0].timeoutMs, 300000);
  assert.deepEqual(action.until[0], { kind: 'origin', value: 'https://portal.azure.com' });
  const directory = path.join(root, 'azure-yaml');
  const store = new FlowStore(path.join(directory, 'flows'));
  // Exercise the actual authored marker on a local portal fixture.
  flow.url = url + '/azure-app';
  action.until[0] = { kind: 'origin', value: url };
  flow.steps.push({ id: 'next', instruction: 'Read welcome marker', timeoutMs: 1000, plan: {
    actions: [{ type: 'extract', source: 'text', output: 'welcome', locator: { target: { by: 'text', value: 'Welcome back', exact: false } } }], expect: [],
  } });
  await store.save(flow.id, stringify(flow), null);
  const runner = new Runner(store, directory, async () => { throw new Error('Azure saved plan must not invoke resolver'); });
  const run = runner.start(flow.id, { headless: true });
  await run.finished;
  assert.equal(run.view.status, 'completed', JSON.stringify(run.view.events));
  assert.equal(run.view.outputs.welcome, 'Welcome back, Test User!');
  assert.ok(!run.view.events.some(e => e.message.startsWith('Paused:')));
});
