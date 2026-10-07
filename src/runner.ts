import { randomUUID } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { openProfile, locate, unique, ensureNonSecret, waitCondition } from './browser.js';
import { resolvePlan, type Resolver } from './planner.js';
import { interpolate, planSchema, type Flow, type Plan, type Action } from './schema.js';
import { FlowStore, ConflictError } from './store.js';

type Decision = 'continue' | 'retry' | 'done' | 'stop';
type Event = { at: string; message: string };
export type RunView = {
  id: string; flowId: string; mode: 'run' | 'repair'; status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  stepId?: string; actionIndex?: number; events: Event[];
  pause?: { kind: 'manual' | 'before-action' | 'uncertain' | 'verify' | 'input'; message: string; choices: Decision[]; input?: string };
  outputs: Record<string, string>;
};
export type RunOptions = { inputs?: Record<string, string>; repairStep?: string; headless?: boolean };

export class Run {
  readonly view: RunView;
  readonly finished: Promise<void>;
  private inputs: Record<string, string>;
  private pending?: (decision: Decision, value?: string) => void;
  private stopping = false;
  private closeBrowser?: () => Promise<void>;
  constructor(private store: FlowStore, private dataDir: string, flowId: string, private options: RunOptions, private resolver: Resolver) {
    this.inputs = { ...options.inputs };
    this.view = { id: randomUUID(), flowId, mode: options.repairStep ? 'repair' : 'run', status: 'running', events: [], outputs: {} };
    this.finished = this.execute();
  }
  private safe(message: string) {
    let result = message;
    for (const value of Object.values(this.inputs)) if (value) result = result.split(value).join('[input]');
    for (const key of [process.env.OPENROUTER_API_KEY]) if (key) result = result.split(key).join('[redacted]');
    return result.slice(0, 600);
  }
  private async event(message: string) {
    const event = { at: new Date().toISOString(), message: this.safe(message) };
    this.view.events.push(event);
    await mkdir(path.join(this.dataDir, 'runs'), { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.dataDir, 'runs', `${this.view.id}.jsonl`), JSON.stringify(event) + '\n', { mode: 0o600 });
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
    await this.event(`Paused: ${pause.kind}`);
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
      let loaded = await this.store.read(this.view.flowId);
      const flow = loaded.flow;
      if (this.options.repairStep && !flow.steps.some(s => s.id === this.options.repairStep)) throw new Error('Repair step does not exist');
      for (const [name, definition] of Object.entries(flow.inputs)) {
        if (definition.required && !Object.hasOwn(this.inputs, name)) throw new Error(`Missing required input: ${name}`);
      }
      const browser = await openProfile(this.dataDir, flow.profile, this.options.headless);
      let closed = false;
      close = async () => { if (!closed) { closed = true; await browser.close(); } };
      this.closeBrowser = close;
      this.checkStopped();
      const page = browser.page;
      page.setDefaultTimeout(30000);
      await page.goto(flow.url, { waitUntil: 'load', timeout: 30000 });
      await this.event('Browser opened with persistent profile');
      for (const step of flow.steps) {
        this.checkStopped();
        this.view.stepId = step.id;
        page.setDefaultTimeout(step.timeoutMs);
        let plan: Plan;
        const learned = !step.plan || this.options.repairStep === step.id;
        if (learned) {
          await this.event(`Resolving ${step.id}: ${step.plan ? 'explicit repair' : 'missing plan'}`);
          plan = planSchema.parse(await this.resolver(page, step, flow));
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
        if (learned) loaded = await this.store.learn(flow.id, step.id, plan, 'verified', loaded.revision);
        await this.event(`Completed step ${step.id}${plan.expect.length ? ' with outcome checks' : ' (no authored outcome checks)'}`);
      }
      this.view.status = 'completed';
      await this.event('Run completed');
    } catch (error) {
      this.view.status = this.stopping ? 'stopped' : 'failed';
      const message = error instanceof Error ? error.message : 'Run failed';
      // Playwright error text can contain field values; do not retain it.
      await this.event(this.stopping ? 'Run stopped' : /Timeout|Call log:|browserType\.|page\./.test(message) ? 'Browser operation failed; check browser installation and application readiness' : message).catch(() => {});
    } finally {
      await close?.().catch(() => {});
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
