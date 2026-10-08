import 'dotenv/config';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { FlowStore } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './server.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  port: { type: 'string' }, inputs: { type: 'string' }, step: { type: 'string' }, headless: { type: 'boolean', default: false },
} });
const store = new FlowStore(path.resolve(process.env.FLOW_DIR ?? 'flows'));
const runner = new Runner(store, path.resolve(process.env.DATA_DIR ?? '.data'));
const command = positionals[0] ?? 'serve';

async function main() {
  if (command === 'serve') {
    const port = Number(values.port ?? process.env.PORT ?? 4310);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const server = createApp(store, runner).listen(port, '127.0.0.1', () => console.log(`Flow Studio: http://127.0.0.1:${port}`));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close();
      void runner.stopAll().catch(error => { console.error(error); process.exitCode = 1; });
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }
  if (command === 'list') { console.table(await store.list()); return; }
  if (command !== 'run' && command !== 'repair') throw new Error('Usage: npm run flow -- list | run <id> [--inputs file.json] | repair <id> --step <id>');
  const id = positionals[1];
  if (!id) throw new Error('Provide a flow ID');
  if (command === 'repair' && !values.step) throw new Error('Repair requires --step <step-id>');
  const inputs = values.inputs ? JSON.parse(await readFile(values.inputs, 'utf8')) as Record<string, string> : {};
  if (!inputs || Array.isArray(inputs) || Object.values(inputs).some(v => typeof v !== 'string')) throw new Error('Inputs must be an object of strings');
  const run = runner.start(id, { inputs, ...(command === 'repair' ? { repairStep: values.step } : {}), headless: values.headless });
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let interrupted = false;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    void run.stop().catch(() => {});
    terminal.close();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let printed = 0;
  try {
    while (['running', 'paused'].includes(run.view.status)) {
      for (const event of run.view.events.slice(printed)) console.log(event.message);
      printed = run.view.events.length;
      if (run.view.pause) {
        const pause = run.view.pause;
        console.log(pause.message);
        const value = pause.kind === 'input' ? await terminal.question('Value (non-secret): ') : undefined;
        const decision = await terminal.question(`Choose ${pause.choices.join(' / ')}: `);
        if (pause.choices.includes(decision as 'continue')) run.respond(decision as 'continue', value);
      } else await new Promise(resolve => setTimeout(resolve, 200));
    }
    await run.finished;
    for (const event of run.view.events.slice(printed)) console.log(event.message);
    console.log(`Result: ${run.view.status}`);
    if (Object.keys(run.view.outputs).length) console.log(JSON.stringify(run.view.outputs, null, 2));
    if (run.view.status !== 'completed') process.exitCode = 1;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    terminal.close();
    await run.stop();
    await run.finished;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Command failed'); process.exitCode = 1; });
