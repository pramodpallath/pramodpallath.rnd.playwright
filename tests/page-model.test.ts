import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { discoverPageModel, PageModelStore } from '../src/page-model.js';

test('discovers actionable controls and persists validated page models', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'page-model-test-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Supplier Search</h1><label for="supplier">Supplier</label><input id="supplier"><button>Search</button><select aria-label="Status"><option value="open">Open</option></select>');
    const model = await discoverPageModel(page, 'supplier-search');
    assert.ok(model.controls.some(c => c.label === 'Supplier' && c.capabilities.includes('fill')));
    assert.ok(model.controls.some(c => c.label === 'Search' && c.capabilities.includes('click')));
    assert.ok(model.controls.some(c => c.capabilities.includes('select')));
    const store = new PageModelStore(directory);
    await store.save(model);
    assert.deepEqual(await store.read('supplier-search'), model);
    assert.equal((await store.list()).length, 1);
    await assert.rejects(() => store.read('../escape'));
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
