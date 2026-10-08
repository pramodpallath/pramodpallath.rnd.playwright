import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { openProfile } from '../src/browser.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-lock-'));
  const directory = path.join(root, 'profiles', 'default');
  await mkdir(directory, { recursive: true });
  const lock = path.join(directory, '.flow-run.lock');
  return { root, directory, lock };
}
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  return child.pid!;
}

test('dead owner lock is recovered and competing runs retain exclusive ownership', async () => {
  const { root, lock } = await fixture();
  try {
    await writeFile(lock, String(await exitedPid()));
    const results = await Promise.allSettled([openProfile(root, 'default', true), openProfile(root, 'default', true)]);
    const winners = results.filter(result => result.status === 'fulfilled');
    try {
      assert.equal(winners.length, 1);
      assert.equal((await readFile(lock, 'utf8')).trim(), String(process.pid));
    } finally {
      for (const result of winners) if (result.status === 'fulfilled') await result.value.close();
    }
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('live owners and live Chromium singleton owners prevent recovery', async () => {
  const { root, directory, lock } = await fixture();
  try {
    await writeFile(lock, String(process.pid));
    await assert.rejects(openProfile(root, 'default', true), /already in use/);
    assert.equal(await readFile(lock, 'utf8'), String(process.pid));
    const dead = String(await exitedPid());
    await writeFile(lock, dead);
    await symlink(`${os.hostname()}-${process.pid}`, path.join(directory, 'SingletonLock'));
    await assert.rejects(openProfile(root, 'default', true), /Chromium.*still running/);
    assert.equal(await readFile(lock, 'utf8'), dead);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closing the browser releases the lock and old cleanup cannot remove a subsequent lock', async () => {
  const { root, lock } = await fixture();
  try {
    const first = await openProfile(root, 'default', true);
    await first.context.close();
    const second = await openProfile(root, 'default', true);
    try {
      await first.close();
      assert.equal(await readFile(lock, 'utf8'), String(process.pid));
      await assert.rejects(openProfile(root, 'default', true), /already in use/);
    } finally { await second.close(); }
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`CLI ${signal} waits for cleanup and leaves no profile lock`, async () => {
    const { root, lock } = await fixture();
    const flows = path.join(root, 'flows');
    await mkdir(flows);
    await writeFile(path.join(flows, 'signal.yaml'), `version: 1
id: signal
name: Signal
url: http://127.0.0.1:1
steps:
  - id: pause
    instruction: Wait for user
    plan:
      actions:
        - type: ask-user
          mode: browser
          prompt: Continue manually
`);
    // Serve a local fixture so the run reaches a manual pause before shutdown.
    const { createServer } = await import('node:http');
    const server = createServer((_, res) => res.end('<h1>Signal fixture</h1>'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const source = await readFile(path.join(flows, 'signal.yaml'), 'utf8');
    await writeFile(path.join(flows, 'signal.yaml'), source.replace('http://127.0.0.1:1', `http://127.0.0.1:${port}`));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'run', 'signal', '--headless'], {
      cwd: process.cwd(), env: { ...process.env, FLOW_DIR: flows, DATA_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      const deadline = Date.now() + 10000;
      while (!output.includes('Choose continue / stop')) {
        assert.equal(child.exitCode, null, output);
        assert.ok(Date.now() < deadline, output);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      child.kill(signal);
      await Promise.race([exited, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Shutdown timed out: ${output}`)), 5000); timer.unref();
      })]);
      await assert.rejects(readFile(lock), { code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
