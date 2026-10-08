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
import { observe, StepPages, screenshotMasks, type Observation } from '../src/browser.js';
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
    res.setHeader('Content-Type', 'text/html');
    const html = '<!doctype html><title>Fixture</title><h1>Requisition</h1><label>Description<input id="desc"></label><label>Password<input type="password" id="password"></label><button id="create">Create</button><script>localStorage.setItem("visits",String(Number(localStorage.getItem("visits")||0)+1))</script>';
    if (req.url === '/login') { res.end('<button onclick="setTimeout(()=>document.body.innerHTML=\'<h1>Sign in</h1>\',600)">Login</button>'); return; }
    if (req.url === '/popup') { res.end('<a href="/username" target="_blank">Open login</a>'); return; }
    if (req.url === '/username') { res.end('<label>Username<input id="username"></label>'); return; }
    if (req.url === '/reject-value') { res.end('<label>Description<input id="desc" oninput="this.value=\'\'"></label>'); return; }
    if (req.url === '/slow') { setTimeout(() => { res.end(html); }, 1000); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test('username instructions resolve on the opened popup and replay without the LLM', async () => {
  const directory = path.join(root, 'popup-username');
  const store = new FlowStore(path.join(directory, 'flows'));
  await store.save('popup-username', stringify({ version: 1, id: 'popup-username', name: 'Popup username', url: `${url}/popup`, inputs: { Username: { required: true } }, steps: [
    { id: 'open', instruction: 'Click Open login', plan: { actions: [{ type: 'click', locator: { target: { by: 'text', value: 'Open login' } } }], expect: [{ kind: 'visible', locator: { target: { by: 'text', value: 'Open login' } } }] } },
    { id: 'username', instruction: 'Set Username as {Username} in the new page that is opened', timeoutMs: 2000 },
  ] }), null);
  const originalFetch = globalThis.fetch;
  const key = process.env.OPENROUTER_API_KEY, model = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = 'fixture-api-key'; process.env.OPENROUTER_MODEL = 'fixture-model';
  let calls = 0;
  let observed: Observation | undefined;
  globalThis.fetch = async (input, init) => {
    if (input !== 'https://openrouter.ai/api/v1/chat/completions') return originalFetch(input, init);
    calls++;
    const request = JSON.parse(String(init?.body));
    const observation = JSON.parse(request.messages[1].content).observation;
    observed = observation;
    const candidate = observation.candidates.find((c: { label: string }) => c.label === 'Username')?.id ?? null;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: [{ type: 'fill', candidate, value: '{Username}', url: null, checked: null, output: null, source: null, condition: null, prompt: null, mode: null, input: null }], expect: [{ kind: 'value', candidate, value: '{Username}' }], unresolvedReason: null }) } }] }));
  };
  try {
    const runner = new Runner(store, directory);
    const first = runner.start('popup-username', { headless: true, inputs: { Username: 'Pramodpv' } });
    await first.finished;
    assert.equal(observed?.url, `${url}/username`);
    assert.equal(first.view.status, 'completed', JSON.stringify(first.view.events));
    const saved = (await store.read('popup-username')).flow.steps[1];
    assert.equal(saved.learned?.status, 'verified');
    assert.equal(saved.plan?.actions[0].type, 'fill');
    await complete(runner.start('popup-username', { headless: true, inputs: { Username: 'AnotherUser' } }));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key;
    if (model === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = model;
  }
});

test('step page selection waits for delayed popups and rejects missing or ambiguous pages', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const initial = await context.newPage();
    await initial.goto(`${url}/popup`);
    const pages = new StepPages(context, initial);
    // Opening a popup is an action on the current page, not a request to
    // wait for a popup before that action has executed.
    assert.equal(await pages.select('Click Open new tab', 100), initial);
    await initial.evaluate(() => { setTimeout(() => window.open('/username'), 150); });
    const popup = await pages.select('Set Username as {Username} in the new page that is opened', 2000);
    assert.notEqual(popup, initial);
    assert.equal(popup.url(), `${url}/username`);
    assert.equal(await pages.select('Set Username in the new page', 100), popup);
    await context.newPage(); await context.newPage();
    await assert.rejects(pages.select('Fill Username', 100), /Multiple new pages/);
    await context.close();

    const sameTab = await browser.newContext();
    const page = await sameTab.newPage();
    await page.goto(`${url}/popup`);
    const navigation = new StepPages(sameTab, page);
    await assert.rejects(navigation.select('Fill Username in the new page', 100), /No new page opened/);
    await page.goto(`${url}/username`);
    assert.equal(await navigation.select('Fill Username in the new page', 100), page);
    await page.close();
    await assert.rejects(navigation.select('Fill Username', 100), /active page was closed/);
    await sameTab.close();
  } finally { await browser.close(); }
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

test('set-value screenshots show the verified value and still mask passwords', async () => {
  const { store, directory } = await setup('value-screenshot');
  let expected: Buffer | undefined;
  const runner = new Runner(store, directory, async page => {
    const capture = page.screenshot.bind(page);
    page.screenshot = async options => {
      if (await page.locator('#desc').inputValue() === 'Visible username') {
        expected = await capture({ animations: 'disabled', mask: [page.locator('#password')] });
      }
      return capture(options);
    };
    // Match KSFE's saved plan: fill with no authored outcome checks.
    return { actions: [{ type: 'fill', locator: description, value: '{Desc}' }], expect: [] };
  });
  const run = runner.start('value-screenshot', { headless: true, inputs: { Desc: 'Visible username' } });
  await complete(run);
  const screenshot = run.view.screenshots.findLast(s => s.phase === 'after')!;
  assert.ok(expected);
  assert.ok((await readFile(path.join(directory, 'runs', run.view.id, screenshot.file))).equals(expected),
    'The screenshot must display the filled field and mask only sensitive controls');
  const verified = run.view.events.findIndex(e => e.message.includes('Verified set value'));
  assert.ok(verified >= 0, 'Fills must record successful value verification');
  assert.ok(verified < run.view.events.findIndex(e => e.message.includes('Screenshot saved') && e.message.includes('value-set')));
});

test('a rejected fill pauses verification without capturing a successful value-set screenshot', async () => {
  const { store, directory } = await setup('rejected-value', { actions: [{ type: 'fill', locator: description, value: '{Desc}' }], expect: [] });
  const saved = await store.read('rejected-value');
  await store.save('rejected-value', saved.source.replace(url, `${url}/reject-value`), saved.revision);
  const run = new Runner(store, directory).start('rejected-value', { headless: true, inputs: { Desc: 'Requested value' } });
  try {
    await until(() => run.view.pause?.kind === 'verify');
    assert.deepEqual(run.view.pause?.choices, ['retry', 'stop']);
    assert.ok(!run.view.screenshots.some(s => s.phase === 'value-set' || s.phase === 'after'));
    assert.ok(!run.view.events.some(e => e.message.includes('Verified set value')));
    run.respond('retry');
    await until(() => run.view.pause?.kind === 'verify');
    assert.equal(run.view.events.filter(e => e.message.includes('Starting') && e.message.includes('action')).length, 1);
  } finally { await run.stop(); await run.finished; }
});

test('screenshot masks detect sensitive labels and framed fields without hiding usernames', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<label>Username<input id="username"></label><label>PIN<input id="code"></label><input id="card" autocomplete="cc-exp"><iframe id="login"></iframe>');
    await page.frameLocator('#login').locator('body').evaluate(el => { el.innerHTML = '<label>Username<input id="frame-user"></label><input id="frame-password" type="password"><input id="frame-otp" autocomplete="one-time-code">'; });
    const masks = await screenshotMasks(page);
    assert.deepEqual(await Promise.all(masks.map(mask => mask.getAttribute('id'))), ['code', 'card', 'frame-password', 'frame-otp']);
  } finally { await browser.close(); }
});

for (const outcome of ['completed', 'failed', 'stopped'] as const) {
  test(`a ${outcome} run closes its browser and popups and releases the profile`, async () => {
    const { store, directory } = await setup(`close-${outcome}`);
    let context: import('playwright').BrowserContext | undefined;
    let pages: import('playwright').Page[] = [];
    const runner = new Runner(store, directory, async page => {
      context = page.context();
      await page.evaluate(() => window.open('/username'));
      await until(() => context!.pages().length === 2);
      pages = context.pages();
      if (outcome === 'failed') throw new Error('Fixture resolver failed');
      return outcome === 'stopped'
        ? { actions: [{ type: 'ask-user', mode: 'browser', prompt: 'Wait for Stop' }], expect: [] }
        : plan;
    });
    const run = runner.start(`close-${outcome}`, { headless: true, inputs: { Desc: 'x' } });
    try {
      if (outcome === 'stopped') {
        await until(() => run.view.pause?.kind === 'manual');
        await Promise.all([run.stop(), run.stop()]);
      }
      await run.finished;
      assert.equal(run.view.status, outcome, JSON.stringify(run.view.events));
      assert.equal(pages.length, 2);
      assert.ok(pages.every(page => page.isClosed()));
      assert.equal(context!.pages().length, 0);
      await assert.rejects(readFile(path.join(directory, 'profiles', `close-${outcome}`, '.flow-run.lock')), { code: 'ENOENT' });
    } finally { await run.stop(); await run.finished; }
  });
}

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


test('run retains step screenshots and lifecycle logs while awaiting delayed completion', async () => {
  const { store, directory } = await setup('delayed', { actions: [{ type: 'click', locator: { target: { by: 'role', role: 'button', name: 'Login', exact: true } } }], expect: [{ kind: 'visible', locator: { target: { by: 'role', role: 'heading', name: 'Sign in', exact: true } } }] });
  const saved = await store.read('delayed');
  await store.save('delayed', saved.source.replace(url, `${url}/login`).replace('timeoutMs: 300', 'timeoutMs: 3000'), saved.revision);
  const run = new Runner(store, directory).start('delayed', { headless: true, inputs: { Desc: 'x' } });
  await until(() => run.view.events.some(e => e.message.includes('Waiting for step outcome')));
  assert.equal(run.view.status, 'running');
  await complete(run);
  const summary = JSON.parse(await readFile(path.join(directory, 'runs', run.view.id, 'run.json'), 'utf8'));
  assert.equal(summary.status, 'completed');
  assert.deepEqual(summary.screenshots.map((s: { phase: string }) => s.phase), ['before', 'after']);
  for (const screenshot of summary.screenshots) {
    const bytes = await readFile(path.join(directory, 'runs', run.view.id, screenshot.file));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  }
});

test('missing resolver configuration fails before opening browser with a persisted reason', async () => {
  const { store, directory } = await setup('unconfigured');
  const key = process.env.OPENROUTER_API_KEY, model = process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_MODEL;
  try {
    const run = new Runner(store, directory).start('unconfigured', { headless: true, inputs: { Desc: 'x' } });
    await run.finished;
    assert.equal(run.view.status, 'failed');
    assert.ok(run.view.events.some(e => e.message.includes('OPENROUTER')));
    assert.ok(!run.view.events.some(e => e.message.includes('Browser opened')));
    const summary = JSON.parse(await readFile(path.join(directory, 'runs', run.view.id, 'run.json'), 'utf8'));
    assert.equal(summary.status, 'failed');
  } finally {
    if (key !== undefined) process.env.OPENROUTER_API_KEY = key;
    if (model !== undefined) process.env.OPENROUTER_MODEL = model;
  }
});

test('LLM requests and responses are logged with secrets redacted and remain accessible after restart', async () => {
  const { store, directory } = await setup('llm-history');
  const originalFetch = globalThis.fetch;
  const key = process.env.OPENROUTER_API_KEY, model = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = 'fixture-api-key'; process.env.OPENROUTER_MODEL = 'fixture-model';
  globalThis.fetch = async (input, init) => {
    if (input !== 'https://openrouter.ai/api/v1/chat/completions') return originalFetch(input, init);
    const request = JSON.parse(String(init?.body));
    const observation = JSON.parse(request.messages[1].content).observation;
    const candidate = observation.candidates.find((c: { label: string }) => c.label === 'Description').id;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actions: [{ type: 'fill', candidate, value: '{Desc}', url: null, checked: null, output: null, source: null, condition: null, prompt: null, mode: null, input: null }], expect: [{ kind: 'value', candidate, value: '{Desc}' }], unresolvedReason: null }) } }], debug: 'fixture-api-key supplied-value' }), { status: 200 });
  };
  try {
    const run = new Runner(store, directory).start('llm-history', { headless: true, inputs: { Desc: 'supplied-value' } });
    await complete(run);
    const log = await readFile(path.join(directory, 'runs', run.view.id, 'llm.jsonl'), 'utf8');
    assert.ok(!log.includes('fixture-api-key')); assert.ok(!log.includes('supplied-value'));
    const entries = log.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => entry.phase), ['request', 'response']);
    assert.equal(entries[0].request.messages.length, 2);
    assert.equal(entries[1].model, 'fixture-model');
    const appServer = createApp(store, new Runner(store, directory)).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => appServer.once('listening', resolve));
    const address = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
    try {
      const history = await (await fetch(`${address}/api/runs`)).json() as { id: string }[];
      assert.equal(history[0].id, run.view.id);
      assert.equal((await fetch(`${address}/api/runs/${run.view.id}/llm-log`)).status, 200);
      const screenshot = run.view.screenshots[0];
      assert.equal((await fetch(`${address}/api/runs/${run.view.id}/screenshots/${screenshot.file}`)).status, 200);
      assert.equal((await fetch(`${address}/api/runs/${run.view.id}`)).status, 200);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(address);
        await page.locator('.flow-card').click();
        await page.locator('#run-history button').click();
        await page.getByRole('link', { name: 'Open LLM log' }).waitFor();
        assert.equal(await page.locator('#run-artifacts img').count(), 3);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }

    } finally { await new Promise<void>(resolve => appServer.close(() => resolve())); }
  } finally {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key;
    if (model === undefined) delete process.env.OPENROUTER_MODEL; else process.env.OPENROUTER_MODEL = model;
  }
});

test('flow UI refreshes learned steps during a run and adds steps while preserving YAML edits', async () => {
  const { store, directory } = await setup('ui-steps');
  const runner = new Runner(store, directory, async () => ({ ...plan, actions: [...plan.actions, { type: 'ask-user', mode: 'browser', prompt: 'Inspect the filled description.' }] }));
  const start = runner.start.bind(runner);
  runner.start = (id, options) => start(id, { ...options, headless: true });
  const appServer = createApp(store, runner).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => appServer.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(appServer.address() as { port: number }).port}`);
    await page.locator('.flow-card').click();
    await page.locator('#inputs input').fill('Stationery');
    await page.locator('#run').click();
    await page.locator('#steps').getByText('3 actions · candidate', { exact: true }).waitFor();
    assert.ok((await page.locator('#yaml').inputValue()).includes('status: candidate'));
    assert.equal(await page.locator('#add-step').isDisabled(), true);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('#steps').getByText('3 actions · verified', { exact: true }).waitFor();
    await page.waitForFunction(() => !(document.getElementById('add-step') as HTMLButtonElement).disabled);
    assert.equal(await page.locator('#inputs input').inputValue(), 'Stationery');
    const yaml = await page.locator('#yaml').inputValue();
    await page.locator('#yaml').fill('# Keep my edit\n' + yaml);
    await page.getByRole('button', { name: '+ Add step', exact: true }).click();
    await page.locator('#step-form textarea').fill('Click Create');
    await page.getByRole('button', { name: 'Add & save', exact: true }).click();
    await page.locator('#steps').getByText('Click Create', { exact: false }).waitFor();
    const saved = await store.read('ui-steps');
    assert.equal(saved.flow.steps.length, 2);
    assert.equal(saved.flow.steps[1].instruction, 'Click Create');
    assert.ok(saved.source.startsWith('# Keep my edit'));
    assert.equal(await page.locator('#repair-step option').count(), 2);
    assert.equal(await page.locator('#step-count').innerText(), '2');
    await page.reload();
    await page.locator('.flow-card').click();
    await page.locator('#steps li').nth(1).waitFor();
    assert.equal(await page.locator('#steps li').count(), 2);
  } finally {
    await browser.close(); await runner.stopAll();
    await new Promise<void>(resolve => appServer.close(() => resolve()));
  }
});
