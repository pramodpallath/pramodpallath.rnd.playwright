import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { chromium } from 'playwright';
import { FlowStore } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { createApp } from '../src/server.js';

test('instruction placeholders become run inputs and missing values prevent a run', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flow-inputs-'));
  const store = new FlowStore(directory);
  const source = stringify({ version: 1, id: 'inputs', name: 'Inputs', url: 'https://example.com', inputs: { Optional: { required: false } }, steps: [{ id: 'username', instruction: 'Set username to {UserName}, repeat {UserName}, and use {Optional}' }] });
  // Existing files work before their next save, too.
  await writeFile(path.join(directory, 'inputs.yaml'), source);
  const loaded = await store.read('inputs');
  assert.deepEqual(loaded.flow.inputs, { Optional: { required: false }, UserName: { required: true } });
  const saved = await store.save('inputs', '# Preserve comment\n' + source, loaded.revision);
  assert.ok(saved.source.startsWith('# Preserve comment'));
  assert.match(saved.source, /UserName:\n\s+required: true/);
  const runner = new Runner(store, path.join(directory, 'data'));
  const server = createApp(store, runner).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const { token } = await (await fetch(`${base}/api/session`)).json();
    const response = await fetch(`${base}/api/flows/inputs/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Flow-Token': token }, body: JSON.stringify({ inputs: { UserName: '' } }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /UserName/);
    assert.equal(runner.runs.size, 0);
    const page = await browser.newPage();
    await page.goto(base);
    await page.locator('.flow-card').click();
    await page.getByLabel('UserName *', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('UserName *', { exact: true }).count(), 1);
    await page.locator('#run').click();
    await page.getByRole('status').filter({ hasText: 'Fill required inputs before running: UserName' }).waitFor();
    assert.equal(runner.runs.size, 0);
    assert.equal(await page.getByLabel('UserName *', { exact: true }).evaluate(el => el === document.activeElement), true);
    await page.getByLabel('UserName *', { exact: true }).fill('Pramodpv');
    await page.locator('#add-step').click();
    await page.locator('#step-form textarea').fill('Set city to {City} and password to {Password}');
    await page.locator('#submit-step').click();
    await page.getByLabel('City *', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('UserName *', { exact: true }).inputValue(), 'Pramodpv');
    assert.equal((await store.read('inputs')).flow.inputs.City.required, true);
    assert.equal(await page.getByLabel('Password *', { exact: true }).getAttribute('type'), 'password');
    assert.ok(!(await store.read('inputs')).source.includes('Pramodpv'));
  } finally {
    await browser.close();
    await runner.stopAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
