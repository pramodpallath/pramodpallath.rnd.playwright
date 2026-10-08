import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../src/sdk.js';

test('SDK rejects an unresolved discovery workflow before opening a browser', async () => {
  const engine = new WorkflowEngine('/tmp/playwright-sdk-test');
  await assert.rejects(
    engine.start({
      yaml: [
        'version: 1',
        'id: incomplete',
        'name: Incomplete',
        'url: https://example.com',
        'steps:',
        '  - id: first',
        '    instruction: Click the button',
      ].join('\n'),
    }),
    /compiled plan/,
  );
});

test('SDK validates required inputs before opening a browser', async () => {
  const engine = new WorkflowEngine('/tmp/playwright-sdk-test');
  await assert.rejects(
    engine.start({
      yaml: [
        'version: 1',
        'id: missing-input',
        'name: Missing input',
        'url: https://example.com',
        'inputs:',
        '  CustomerId:',
        '    required: true',
        'steps:',
        '  - id: first',
        '    instruction: Read {CustomerId}',
        '    plan:',
        '      actions:',
        '        - type: wait',
        '          condition:',
        '            kind: origin',
        '            value: https://example.com',
      ].join('\n'),
    }),
    /Missing required inputs: CustomerId/,
  );
});
