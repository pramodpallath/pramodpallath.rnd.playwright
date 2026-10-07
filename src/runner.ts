import { randomUUID } from 'node:crypto';
import { mkdir, appendFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { openProfile, locate, unique, ensureNonSecret, waitCondition } from './browser.js';
import { resolvePlan, type Resolver } from './planner.js';
import { interpolate, planSchema, type Flow, type Plan, type Action } from './schema.js';
import { FlowStore, ConflictError } from './store.js';

type Decision = 'continue' | 'retry' | 'done' | 'stop';
type Event = { at: string; runId: string; flowId: string; stepId?: string; actionIndex?: number; message: string };
export type Screenshot = { at: string; stepId: string; phase: 'before' | 'after' | 'paused' | 'failed'; file: string };
export type RunView = {
  id: string; flowId: string; mode: 'run' | 'repair'; status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  stepId?: string; actionIndex?: number; events: Event[];
  pause?: { kind: 'manual' | 'before-action' | 'uncertain' | 'verify' | 'input'; message: string; choices: Decision[]; input?: string };
  outputs: Record<string, string>; screenshots: Screenshot[]; startedAt: string; finishedAt?: string;
};
export type RunOptions = { inputs?: Record<string, string>; repairStep?: string; headless?: boolean };

export class Run {
  readonly view: RunView;
  readonly finished: Promise<void>;
  private inputs: Record<string, string>;
  private pending?: (decision: Decision, value?: string) => void;
  private stopping = false;
  private page?: Page;
  private closeBrowser?: () => Promise<void>;
  constructor(private store: FlowStore, private dataDir: string, flowId: string, private options: RunOptions, private resolver: Resolver) {
    this.inputs = { ...options.inputs };
    this.view = { id: randomUUID(), flowId, mode: options.repairStep ? 'repair' : 'run', status: 'running', events: [], outputs: {}, screenshots: [], startedAt: new Date().toISOString() };
    this.finished = this.execute();
  }
  private redact(message: string) {
    let result = message;
    for (const value of Object.values(this.inputs)) if (value) { result = result.split(JSON.stringify(value).slice(1, -1)).join('[input]'); result = result.split(value).join('[input]'); }
    for (const key of [process.env.OPENROUTER_API_KEY]) if (key) result = result.split(key).join('[redacted]');
    return result;
  }
  private safe(message: string) { return this.redact(message).slice(0, 600); }
  private async llmLog(entry: Record<string, unknown>) {
    const directory = path.join(this.dataDir, 'runs', this.view.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const record = { at: new Date().toISOString(), runId: this.view.id, flowId: this.view.flowId, stepId: this.view.stepId, ...entry };
    await appendFile(path.join(directory, 'llm.jsonl'), this.redact(JSON.stringify(record)) + '\n', { mode: 0o600 });
    await this.event(`LLM ${entry.phase}${entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''}`);
  }
  private async event(message: string) {
    const event: Event = { at: new Date().toISOString(), runId: this.view.id, flowId: this.view.flowId, stepId: this.view.stepId, actionIndex: this.view.actionIndex, message: this.safe(message) };
    this.view.events.push(event);
    await mkdir(path.join(this.dataDir, 'runs'), { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.dataDir, 'runs', `${this.view.id}.jsonl`), JSON.stringify(event) + '\n', { mode: 0o600 });
    await this.persist();
  }
  private async persist() {
    const directory = path.join(this.dataDir, 'runs', this.view.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const { outputs: _, pause: __, ...summary } = this.view;
    const temporary = path.join(directory, 'run.json.tmp');
    await writeFile(temporary, JSON.stringify(summary, null, 2), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'run.json'));
  }
  private async screenshot(phase: Screenshot['phase']) {
    if (!this.page || !this.view.stepId || this.page.isClosed()) return;
    const file = `${String(this.view.screenshots.length + 1).padStart(3, '0')}-${this.view.stepId}-${phase}.png`;
    const destination = path.join(this.dataDir, 'runs', this.view.id, file);
    try {
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await this.page.screenshot({ path: destination, timeout: 5000, animations: 'disabled',
        mask: [this.page.locator('input, textarea, [contenteditable], [autocomplete*="cc-"], [id*="otp" i], [id*="token" i], [id*="secret" i]')] });
      await chmod(destination, 0o600);
      this.view.screenshots.push({ at: new Date().toISOString(), stepId: this.view.stepId, phase, file });
      await this.event(`Screenshot saved: ${this.view.stepId} (${phase})`);
    } catch { await this.event(`Screenshot unavailable: ${this.view.stepId} (${phase})`); }
  }
  respond(decision: Decision, value?: string) {
    if (!this.pending || !this.view.pause?.choices.includes(decision)) throw new Error('Run is not waiting for that decision');
    if (this.view.pause.kind === 'input' && decision === 'continue' && value === undefined) throw new Error('Provide an input value');
    this.pending(decision, value);
  }
  async stop() {
    this.stopping = true;
    this.pending?.('stop');
    await this.closeBrowser?.();
  }
  private checkStopped() { if (this.stopping) throw new Error('Run stopped'); }
  private async pause(pause: NonNullable<RunView['pause']>) {
    this.checkStopped();
    await this.screenshot('paused');
    await this.event(`Paused: ${pause.kind} — ${pause.message}`);
    this.checkStopped();
    return new Promise<Decision>((resolve, reject) => {
      this.view.status = 'paused'; this.view.pause = { ...pause, message: this.safe(pause.message) };
      this.pending = (decision, value) => {
        this.pending = undefined;
        const input = this.view.pause?.input;
        if (input && value !== undefined) this.inputs[input] = value;
        delete this.view.pause;
        if (decision === 'stop') { this.stopping = true; reject(new Error('Run stopped')); }
        else { this.view.status = 'running'; resolve(decision); }
      };
      if (this.stopping) this.pending('stop');
    });
  }
  private async execute() {
    let close: (() => Promise<void>) | undefined;
    try {
      await this.event('Run started');
      let loaded = await this.store.read(this.view.flowId);
      const flow = loaded.flow;
      if (this.options.repairStep && !flow.steps.some(s => s.id === this.options.repairStep)) throw new Error('Repair step does not exist');
      for (const [name, definition] of Object.entries(flow.inputs)) {
        if (definition.required && !Object.hasOwn(this.inputs, name)) throw new Error(`Missing required input: ${name}`);
      }
      if (this.resolver === resolvePlan && flow.steps.some(step => !step.plan || this.options.repairStep === step.id) && (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL)) {
        throw new Error('Missing OPENROUTER_API_KEY or OPENROUTER_MODEL. Configure .env and restart the server, or add a saved plan to the YAML.');
      }
      await this.event('Opening browser and loading flow URL');
      const browser = await openProfile(this.dataDir, flow.profile, this.options.headless);
      let closed = false;
      close = async () => { if (!closed) { closed = true; await browser.close(); } };
      this.closeBrowser = close;
      this.checkStopped();
      const page = browser.page;
      this.page = page;
      page.setDefaultTimeout(30000);
      await page.goto(flow.url, { waitUntil: 'load', timeout: 30000 });
      await this.event('Browser opened with persistent profile');
      for (const step of flow.steps) {
        this.checkStopped();
        this.view.stepId = step.id;
        delete this.view.actionIndex;
        const stepStarted = Date.now();
        await this.event(`Started step ${step.id}: ${step.instruction}`);
        await this.screenshot('before');
        page.setDefaultTimeout(step.timeoutMs);
        let plan: Plan;
        const learned = !step.plan || this.options.repairStep === step.id;
        if (learned) {
          await this.event(`Resolving ${step.id}: ${step.plan ? 'explicit repair' : 'missing plan'}`);
          plan = planSchema.parse(await this.resolver(page, step, flow, entry => this.llmLog(entry)));
          await this.event(`Plan resolved: ${plan.actions.length} actions, ${plan.expect.length} outcome checks`);
          this.checkStopped();
          loaded = await this.store.learn(flow.id, step.id, plan, 'candidate', loaded.revision);
        } else {
          plan = step.plan!;
          await this.event(`Replaying saved plan: ${step.id}`);
        }
        // Editing a YAML file during a run must stop before the next action.
        for (let i = 0; i < plan.actions.length; i++) {
          this.view.actionIndex = i;
          const action = plan.actions[i];
          let finished = false;
          while (!finished) {
            this.checkStopped();
            if ((await this.store.read(flow.id)).revision !== loaded.revision) throw new ConflictError('Flow edited during run; stopped before next action');
            if (action.type === 'ask-user') {
              await this.pause({ kind: action.mode === 'input' ? 'input' : 'manual', message: action.prompt, choices: ['continue', 'stop'], ...(action.mode === 'input' ? { input: action.input } : {}) });
              finished = true;
              continue;
            }
            await this.event(`Starting ${step.id} action ${i + 1}: ${action.type}`);
            let dispatched = false;
            try {
              // Interpolation and preflight happen before any browser mutation.
              const value = 'value' in action ? interpolate(action.value, this.inputs) : undefined;
              if ('locator' in action) {
                const locator = locate(page, action.locator);
                await locator.waitFor({ state: 'visible', timeout: step.timeoutMs });
                await unique(locator);
                if (['fill', 'select', 'extract'].includes(action.type)) await ensureNonSecret(locator);
                if (action.type === 'click') await locator.click({ trial: true });
              }
              dispatched = true;
              switch (action.type) {
                case 'navigate': await page.goto(interpolate(action.url, this.inputs), { waitUntil: 'load', timeout: step.timeoutMs }); break;
                case 'click': await locate(page, action.locator).click(); break;
                case 'fill': await locate(page, action.locator).fill(value!); await waitCondition(page, { kind: 'value', locator: action.locator, value: action.value }, this.inputs, step.timeoutMs); break;
                case 'select': await locate(page, action.locator).selectOption(value!); break;
                case 'check': await locate(page, action.locator).setChecked(action.checked); break;
                case 'wait': await waitCondition(page, action.condition, this.inputs, step.timeoutMs); break;
                case 'extract': {
                  const locator = locate(page, action.locator);
                  this.view.outputs[action.output] = action.source === 'value' ? await locator.inputValue() : (await locator.innerText()).trim();
                  break;
                }
              }
              finished = true;
              await this.event(`Executed ${step.id} action ${i + 1}: ${action.type}`);
            } catch (error) {
              if (this.stopping) throw error;
              await this.event(`Action ${i + 1} could not complete (${dispatched ? 'after dispatch' : 'before dispatch'})`);
              const uncertain = dispatched && !['wait', 'extract', 'fill', 'select', 'check'].includes(action.type);
              const decision = await this.pause({
                kind: uncertain ? 'uncertain' : 'before-action',
                message: uncertain
                  ? 'Action was dispatched, but its outcome is uncertain. Inspect the browser. Mark done only if it completed or you completed it manually.'
                  : 'The action could not complete. Inspect the browser, then retry or mark done after completing it manually. Saved-plan failures never invoke the LLM.',
                choices: uncertain ? ['done', 'stop'] : ['retry', 'done', 'stop'],
              });
              finished = decision === 'done';
            }
          }
        }
        delete this.view.actionIndex;
        await this.event(`Waiting for step outcome: ${plan.expect.length} checks (timeout ${step.timeoutMs}ms per check)`);
        if (!plan.expect.length && plan.actions.some(action => action.type === 'click' || action.type === 'navigate')) {
          await this.pause({ kind: 'verify', message: 'This step has no expected outcome. Confirm in the browser that it completed, then continue. Add plan.expect to verify completion automatically.', choices: ['continue', 'stop'] });
        }
        for (const condition of plan.expect) {
          let verified = false;
          while (!verified) {
            this.checkStopped();
            try { await waitCondition(page, condition, this.inputs, step.timeoutMs); verified = true; }
            catch (error) {
              if (this.stopping) throw error;
              await this.pause({ kind: 'verify', message: 'Expected outcome was not reached. Inspect or complete the action manually, then retry verification. The action will not be repeated.', choices: ['retry', 'stop'] });
            }
          }
        }
        await this.screenshot('after');
        await this.event(`Step duration: ${Date.now() - stepStarted}ms`);
        if (learned) loaded = await this.store.learn(flow.id, step.id, plan, 'verified', loaded.revision);
        await this.event(`Completed step ${step.id}${plan.expect.length ? ' with outcome checks' : ' (no authored outcome checks)'}`);
      }
      this.view.status = 'completed';
      this.view.finishedAt = new Date().toISOString();
      await this.event('Run completed');
    } catch (error) {
      this.view.status = this.stopping ? 'stopped' : 'failed';
      this.view.finishedAt = new Date().toISOString();
      if (!this.stopping) await this.screenshot('failed').catch(() => {});
      const message = error instanceof Error ? error.message : 'Run failed';
      // Playwright error text can contain field values; do not retain it.
      await this.event(this.stopping ? 'Run stopped' : /Timeout|Call log:|browserType\.|page\./.test(message) ? 'Browser operation failed; check browser installation and application readiness' : message).catch(() => {});
    } finally {
      await close?.().catch(() => {});
      this.page = undefined;
      this.closeBrowser = undefined;
      this.pending = undefined;
      delete this.view.pause;
    }
  }
}

export class Runner {
  readonly runs = new Map<string, Run>();
  constructor(readonly store: FlowStore, readonly dataDir: string, private resolver: Resolver = resolvePlan) {}
  start(flowId: string, options: RunOptions = {}) {
    const run = new Run(this.store, this.dataDir, flowId, options, this.resolver);
    this.runs.set(run.view.id, run);
    return run;
  }
  async stopAll() { await Promise.all([...this.runs.values()].map(run => run.stop())); }
}
