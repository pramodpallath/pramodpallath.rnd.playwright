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

test('SDK executes a compiled action and returns its output from an isolated workspace', async () => {
  const { createServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { stringify } = await import('yaml');
  const directory = await mkdtemp(join(tmpdir(), 'adapter-sdk-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<h1>Ready</h1>');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const handle = await new WorkflowEngine(directory).start({ headless: true, yaml: stringify({
      version: 1, id: 'compiled', name: 'Compiled', url: `http://127.0.0.1:${address.port}`,
      steps: [{ id: 'read', instruction: 'Read the heading', plan: { actions: [{
        type: 'extract', locator: { target: { by: 'css', value: 'h1' } }, source: 'text', output: 'heading',
      }] } }],
    }) });
    const result = await handle.result;
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.outputs, { heading: 'Ready' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
