import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { bindAction } from '../src/actions/registry.js';
import type { ActionContext } from '../src/actions/contract.js';
import type { MasterDataSet } from '../src/master-data.js';
import type { LocatorSpec } from '../src/schema.js';

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const css = (value: string): LocatorSpec => ({ target: { by: 'css', value } });
const context = (page: Page, inputs: Record<string, string> = {}): ActionContext => ({
  page, inputs, timeoutMs: 250, flowId: 'adapter-test',
  saveMasterData: async () => { throw new Error('Unexpected master data write'); },
});

test('click preparation checks actionability without dispatching; ambiguous targets cannot execute', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button onclick="this.textContent=\'Clicked\'">Click</button>');
    const action = bindAction({ type: 'click', locator: css('button') }, context(page));
    const prepared = await action.prepare();
    assert.equal(await page.locator('button').innerText(), 'Click');
    await prepared.execute();
    assert.equal(await page.locator('button').innerText(), 'Clicked');
    assert.equal(action.retryAfterDispatch, false);
    await page.setContent('<button>One</button><button>Two</button>');
    await assert.rejects(action.prepare());
  } finally { await page.close(); }
});

test('native selection preserves value semantics and verification never dispatches another change', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<select id="country" onchange="document.body.dataset.changes=String(Number(document.body.dataset.changes||0)+1)">
      <option value="">Choose</option><option value="ae">United Arab Emirates</option></select>`);
    const action = bindAction({ type: 'select', locator: css('#country'), value: '{Country}' }, context(page, { Country: 'ae' }));
    const prepared = await action.prepare();
    assert.equal(await page.locator('#country').inputValue(), '');
    await prepared.execute();
    await action.verify!();
    await action.verify!();
    assert.equal(await page.locator('#country').inputValue(), 'ae');
    assert.equal(await page.locator('body').getAttribute('data-changes'), '1');
    assert.equal(action.controlAdapter, 'native-select');
    assert.equal(action.evidence, 'value-set');
  } finally { await page.close(); }
});

test('authored combobox waits for its option after opening and verifies the committed value', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button id="combo" onclick="document.querySelector('#choice').hidden=false">Choose</button>
      <button id="choice" hidden onclick="document.querySelector('#selected').value='ae';this.hidden=true">United Arab Emirates</button>
      <input id="selected" readonly>`);
    const action = bindAction({ type: 'select-combobox', locator: css('#combo'), option: css('#choice'),
      verify: css('#selected'), value: '{Country}' }, context(page, { Country: 'ae' }));
    const prepared = await action.prepare();
    assert.equal(await page.locator('#choice').isVisible(), false);
    await prepared.execute();
    assert.equal(await page.locator('#selected').inputValue(), 'ae');
    assert.equal(action.controlAdapter, 'authored-combobox');
    const mismatch = bindAction({ type: 'select-combobox', locator: css('#combo'), option: css('#choice'),
      verify: css('#selected'), value: 'wrong' }, context(page));
    await assert.rejects((await mismatch.prepare()).execute(), /not verified/);
  } finally { await page.close(); }
});

test('selection rejects unsupported controls and missing inputs before any interaction', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button id="custom" onclick="this.textContent=\'Changed\'">Choose</button>');
    await assert.rejects(bindAction({ type: 'select', locator: css('#custom'), value: 'ae' }, context(page)).prepare(), /requires a select element/);
    await assert.rejects(bindAction({ type: 'select-combobox', locator: css('#custom'), option: css('#missing'),
      value: '{Missing}' }, context(page)).prepare(), /Missing input/);
    assert.equal(await page.locator('#custom').innerText(), 'Choose');
  } finally { await page.close(); }
});

test('fill policy uses the authored placeholder and verification can follow manual correction', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<input id="secret" type="password"><input id="ordinary">');
    const ctx = context(page, { Password: 'fixture-secret', Other: 'fixture-secret' });
    await assert.rejects(bindAction({ type: 'fill', locator: css('#secret'), value: '{Other}' }, ctx).prepare(), /manual browser entry/);
    const password = bindAction({ type: 'fill', locator: css('#secret'), value: '{Password}' }, ctx);
    await (await password.prepare()).execute();
    await password.verify!();
    const fill = bindAction({ type: 'fill', locator: css('#ordinary'), value: 'expected' }, ctx);
    await (await fill.prepare()).execute();
    await page.locator('#ordinary').fill('wrong');
    await assert.rejects(fill.verify!(), /condition was not reached/);
    await page.locator('#ordinary').fill('expected');
    await fill.verify!();
  } finally { await page.close(); }
});

test('table and master-data adapters return outputs and persist only through the supplied dependency', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<table><thead><tr><th>Code</th><th>Name</th></tr></thead><tbody><tr><td>ae</td><td>UAE</td></tr></tbody></table>');
    let saved: MasterDataSet | undefined;
    const ctx = { ...context(page), saveMasterData: async (dataset: MasterDataSet) => { saved = dataset; } };
    const table = bindAction({ type: 'extract-table', locator: css('table'), output: 'countries', maxPages: 1, maxRows: 10 }, ctx);
    const result = await (await table.prepare()).execute();
    assert.deepEqual(result?.output, { name: 'countries', value: {
      rows: [{ Code: 'ae', Name: 'UAE' }], headers: ['Code', 'Name'], pagesVisited: 1, complete: true,
    } });
    const master = bindAction({ type: 'extract-master-data', locator: css('table'), registry: 'countries',
      valueColumn: 'Code', labelColumn: 'Name', maxPages: 1, maxRows: 10 }, ctx);
    const prepared = await master.prepare();
    assert.equal(saved, undefined);
    await prepared.execute();
    assert.deepEqual(saved?.records, [{ value: 'ae', label: 'UAE' }]);
    assert.equal(saved?.sourceWorkflow, 'adapter-test');
  } finally { await page.close(); }
});
