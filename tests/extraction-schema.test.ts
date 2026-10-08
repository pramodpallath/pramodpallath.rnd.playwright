import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowSchema } from '../src/schema.js';

const base = {
  version: 1 as const, id: 'data-flow', name: 'Data Flow',
  url: 'https://example.com', steps: [] as unknown[],
};

test('table extraction requires bounded pagination', () => {
  const parsed = flowSchema.parse({
    ...base,
    steps: [{ id: 'read', instruction: 'Read table', plan: { actions: [{
      type: 'extract-table',
      locator: { target: { by: 'role', role: 'table', name: 'Accounts' } },
      output: 'accounts', maxPages: 4, maxRows: 100,
    }] } }],
  });
  assert.equal(parsed.steps[0].plan?.actions[0].type, 'extract-table');
  assert.equal(flowSchema.safeParse({
    ...base, steps: [{ id: 'read', instruction: 'Read table', plan: { actions: [{
      type: 'extract-table',
      locator: { target: { by: 'role', role: 'table', name: 'Accounts' } },
      output: 'accounts', maxPages: 10000,
    }] } }],
  }).success, false);
});

test('master data extraction needs column mappings', () => {
  const parsed = flowSchema.parse({
    ...base,
    steps: [{ id: 'master', instruction: 'Extract branches', plan: { actions: [{
      type: 'extract-master-data',
      locator: { target: { by: 'css', value: '#branches' } },
      registry: 'branches', valueColumn: 'Code', labelColumn: 'Name',
    }] } }],
  });
  assert.equal(parsed.steps[0].plan?.actions[0].type, 'extract-master-data');
});
