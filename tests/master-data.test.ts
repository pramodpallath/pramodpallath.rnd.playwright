import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MasterDataRegistry } from '../src/master-data.js';

test('master data preserves codes and resolves exact labels', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'master-data-'));
  try {
    const registry = new MasterDataRegistry(directory);
    await registry.save({
      id: 'branches', sourceWorkflow: 'branch-discovery',
      capturedAt: new Date().toISOString(), complete: true,
      pagesVisited: 2, keyColumn: 'Code', labelColumn: 'Name',
      records: [{ value: '001', label: 'Main' }, { value: '002', label: 'West' }],
    });
    assert.equal(await registry.resolve('branches', 'Main'), '001');
    await assert.rejects(registry.resolve('branches', 'Unknown'), /missing or ambiguous/);
    await assert.rejects(registry.save({
      id: 'branches', sourceWorkflow: 'branch-discovery',
      capturedAt: new Date().toISOString(), complete: false,
      pagesVisited: 1, keyColumn: 'Code', labelColumn: 'Name',
      records: [{ value: '001', label: 'Main' }],
    }), /Cannot replace complete/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('master data rejects duplicate keys', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'master-data-'));
  try {
    const registry = new MasterDataRegistry(directory);
    await assert.rejects(registry.save({
      id: 'branches', sourceWorkflow: 'branch-discovery',
      capturedAt: new Date().toISOString(), complete: false,
      pagesVisited: 1, keyColumn: 'Code', labelColumn: 'Name',
      records: [{ value: '001', label: 'Main' }, { value: '001', label: 'Duplicate' }],
    }), /unique/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
