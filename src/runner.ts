import { timestamp } from './timestamp.js';
import { mkdir, appendFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { openProfile, StepPages, locate, unique, ensureNonSecret, ensureFillAllowed, waitCondition, conditionsMet, screenshotMasks } from './browser.js';
import { resolvePlan, type Resolver } from './planner.js';
import { interpolate, planSchema, type Flow, type Plan, type Action } from './schema.js';
import { FlowStore, ConflictError } from './store.js';
import { diagnoseAndRepair } from './discovery.js';

export const runLogFile = (run: { startedAt: string; id: string }) => `${run.id}.jsonl`;
export type LlmLogFile = { timestamp?: string; at: string; phase: string; file: string };

type Decision = 'continue' | 'retry' | 'done' | 'stop';
type Event = { timestamp?: string; at: string; runId: string; flowId: string; stepId?: string; actionIndex?: number; message: string };
export type Screenshot = { at: string; stepId: string; phase: 'before' | 'value-set' | 'after' | 'paused' | 'failed'; actionIndex?: number; file: string };
export type RunView = {
  id: string; flowId: string; mode: 'run' | 'repair' | 'trial'; status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  stepId?: string; actionIndex?: number; events: Event[];
  pause?: { kind: 'manual' | 'before-action' | 'uncertain' | 'verify' | 'input'; message: string; choices: Decision[]; input?: string };
  logFile?: string; llmLogs?: LlmLogFile[]; outputs: Record<string, string>; screenshots: Screenshot[]; startedAt: string; finishedAt?: string;
};
export type RunOptions = { inputs?: Record<string, string>; repairStep?: string; headless?: boolean; trial?: boolean; autoRepair?: boolean; maxRepairs?: number };

export class Run {
  readonly view: RunView;
  readonly finished: Promise<void>;
  private inputs: Record<string, string>;
  private pending?: (decision: Decision, value?: string) => void;
  private stopping = false;
  private repairs = 0;
  private page?: Page;
  private closeBrowser?: () => Promise<void>;
  constructor(private store: FlowStore, private dataDir: string, flowId: string, private options: RunOptions, private resolver: Resolver) {
    this.inputs = { ...options.inputs };
    this.view = { id: timestamp(), flowId, mode: options.trial ? 'trial' : options.repairStep ? 'repair' : 'run', status: 'running', events: [], llmLogs: [], outputs: {}, screenshots: [], startedAt: new Date().toISOString() };
    this.view.logFile = runLogFile(this.view);
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
    const at = new Date().toISOString();
    const phase = String(entry.phase ?? 'entry').replace(/[^a-z0-9_-]/gi, '_');
    const logs = this.view.llmLogs!;
    const time = timestamp();
    const file = `${time}-llm-${phase}.json`;
    const record: Record<string, unknown> = { ...entry, timestamp: time, at, runId: this.view.id, flowId: this.view.flowId, stepId: this.view.stepId };
    if (typeof record.response === 'string') {
      try { record.response = JSON.parse(record.response); } catch { /* Preserve non-JSON provider responses. */ }
    }
    // Redact compact JSON first so escaped input values are still matched.
    const redacted = JSON.parse(this.redact(JSON.stringify(record)));
    await writeFile(path.join(directory, file), JSON.stringify(redacted, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    logs.push({ timestamp: time, at, phase, file });
    await this.event(`LLM ${entry.phase}${entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''}`);
  }
  private async event(message: string) {
    const event: Event = { timestamp: timestamp(), at: new Date().toISOString(), runId: this.view.id, flowId: this.view.flowId, stepId: this.view.stepId, actionIndex: this.view.actionIndex, message: this.safe(message) };
    this.view.events.push(event);
    await mkdir(path.join(this.dataDir, 'runs'), { recursive: true, mode: 0o700 });
    await appendFile(path.join(this.dataDir, 'runs', runLogFile(this.view)), JSON.stringify(event) + '\n', { mode: 0o600 });
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
        mask: await screenshotMasks(this.page) });
      await chmod(destination, 0o600);
      this.view.screenshots.push({ at: new Date().toISOString(), stepId: this.view.stepId, phase, file,
        ...(phase === 'value-set' ? { actionIndex: this.view.actionIndex } : {}) });
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
  private async pause(pause: NonNullable<RunView['pause']>, autoContinue?: () => Promise<boolean>) {
    this.checkStopped();
    await this.screenshot('paused');
    await this.event(`Paused: ${pause.kind} — ${pause.message}`);
    this.checkStopped();
    return new Promise<Decision>((resolve, reject) => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.view.status = 'paused'; this.view.pause = { ...pause, message: this.safe(pause.message) };
      this.pending = (decision, value) => {
        active = false;
        clearTimeout(timer);
        this.pending = undefined;
        const input = this.view.pause?.input;
        if (input && value !== undefined) this.inputs[input] = value;
        delete this.view.pause;
        if (decision === 'stop') { this.stopping = true; reject(new Error('Run stopped')); }
        else { this.view.status = 'running'; resolve(decision); }
      };
      if (this.stopping) this.pending('stop');
      const poll = async () => {
        if (!active) return;
        try {
          const ready = await autoContinue!();
          if (!active) return;
          if (ready) { this.pending?.('continue'); return; }
        } catch (error) {
          if (!active) return;
          active = false; clearTimeout(timer); this.pending = undefined;
          delete this.view.pause; this.view.status = 'running'; reject(error); return;
        }
        timer = setTimeout(() => { void poll(); }, 100);
      };
      if (autoContinue && active) void poll();
    });
  }
  private async conditionalUser(page: Page, action: Extract<Action, { type: 'ask-user' }>, timeoutMs: number) {
    const ready = () => conditionsMet(page, action.until!, this.inputs);
    let deadline = Date.now() + timeoutMs;
    const graceDeadline = Math.min(deadline, Date.now() + (action.graceMs ?? 1500));
    while (true) {
      this.checkStopped();
      if (page.isClosed()) throw new Error('The application page was closed during manual completion');
      if (await ready()) { await this.event('Manual completion conditions verified; continuing automatically'); return; }
      if (Date.now() < graceDeadline) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      if (Date.now() >= deadline) {
        await this.pause({ kind: 'verify', message: 'Manual completion timed out. Complete the browser action and retry verification, or stop. The next action has not run.', choices: ['retry', 'stop'] });
        deadline = Date.now() + timeoutMs;
        continue;
      }
      await this.pause({ kind: 'manual', message: `${action.prompt} This run continues automatically when completion is verified.`, choices: ['continue', 'stop'] }, async () => {
        this.checkStopped();
        if (page.isClosed()) throw new Error('The application page was closed during manual completion');
        return Date.now() >= deadline || await ready();
      });
      // Continue is only a request to verify; it never bypasses the conditions.
    }
  }
  private async execute() {
    let close: (() => Promise<void>) | undefined;
    try {
      await this.event('Run started');
      let loaded = await this.store.read(this.view.flowId);
      const flow = loaded.flow;
      if (this.options.trial && flow.steps.some(s => s.plan?.actions.some(a => a.type === 'ask-user'))) await this.event('Trial contains manual actions; user interaction may be necessary');
      if (this.options.repairStep && !flow.steps.some(s => s.id === this.options.repairStep)) throw new Error('Repair step does not exist');
      for (const [name, definition] of Object.entries(flow.inputs)) {
        if (definition.required && !Object.hasOwn(this.inputs, name)) throw new Error(`Missing required input: ${name}`);
      }
      if (this.resolver === resolvePlan && flow.steps.some(step => !step.plan || this.options.repairStep === step.id) && (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL)) {
        throw new Error('Missing OPENROUTER_API_KEY or OPENROUTER_MODEL. Configure .env and restart the server, or add a saved plan to the YAML.');
      }
      await this.event('Opening browser and loading flow URL');
      const browser = await openProfile(this.dataDir, flow.profile, this.options.headless);
      let closing: Promise<void> | undefined;
      close = () => closing ??= browser.close();
      this.closeBrowser = close;
      browser.context.once('close', () => {
        if (!closing && (this.view.status === 'running' || this.view.status === 'paused')) {
          this.stopping = true;
          this.pending?.('stop');
        }
      });
      this.checkStopped();
      const page = browser.page;
      this.page = page;
      page.setDefaultTimeout(30000);
      await page.goto(flow.url, { waitUntil: 'load', timeout: 30000 });
      const pages = new StepPages(browser.context, page);
      await this.event('Browser opened with persistent profile');
      for (const step of flow.steps) {
        this.checkStopped();
        this.view.stepId = step.id;
        delete this.view.actionIndex;
        const stepStarted = Date.now();
        await this.event(`Started step ${step.id}: ${step.instruction}`);
        const page = await pages.select(step.instruction, step.timeoutMs);
        if (this.page !== page) await this.event('Switched to the newly opened page');
        this.page = page;
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
          let action = plan.actions[i];
          let finished = false;
          while (!finished) {
            this.checkStopped();
            if ((await this.store.read(flow.id)).revision !== loaded.revision) throw new ConflictError('Flow edited during run; stopped before next action');
            if (action.type === 'ask-user') {
              if (action.until) {
                await this.conditionalUser(page, action, step.timeoutMs);
                pages.retainApplication(page);
              }
              else await this.pause({ kind: action.mode === 'input' ? 'input' : 'manual', message: action.prompt, choices: ['continue', 'stop'], ...(action.mode === 'input' ? { input: action.input } : {}) });
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
                if (action.type === 'fill') await ensureFillAllowed(locator, action.value);
                else if (['select', 'extract'].includes(action.type)) await ensureNonSecret(locator);
                if (action.type === 'click') await locator.click({ trial: true });
              }
              dispatched = true;
              switch (action.type) {
                case 'navigate': await page.goto(interpolate(action.url, this.inputs), { waitUntil: 'load', timeout: step.timeoutMs }); break;
                case 'click': await locate(page, action.locator).click(); break;
                case 'fill': await locate(page, action.locator).fill(value!); break;
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
              if (this.options.trial && this.options.autoRepair && !uncertain && this.repairs < (this.options.maxRepairs ?? 3)) {
                await this.screenshot('failed');
                try {
                  const repair = await diagnoseAndRepair(page, step, flow, plan, error instanceof Error ? error.name : 'Action preflight failed', entry => this.llmLog(entry));
                  if (repair.plan.actions.some(a => a.type === 'ask-user')) throw new Error('Repair requires user intervention');
                  // A changed plan must be replayed from a fresh trial, never jumped into mid-step.
                  loaded = await this.store.learn(flow.id, step.id, repair.plan, 'candidate', loaded.revision);
                  this.repairs++;
                  await this.event(`Candidate repair saved for ${step.id}; restart the trial to verify (${repair.reason})`);
                  throw new Error('TRIAL_REPAIR_RESTART_REQUIRED');
                } catch (repairError) {
                  if (repairError instanceof Error && repairError.message === 'TRIAL_REPAIR_RESTART_REQUIRED') throw repairError;
                  await this.event('Automatic repair could not be validated; ending this trial safely');
                  throw new Error('Trial blocked; manual repair needed');
                }
              }
              if (this.options.trial) throw new Error(uncertain ? 'Trial stopped after uncertain action; inspect outcome before retrying' : 'Trial action failed; inspect evidence and repair the rule');
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
          if (action.type === 'fill' || action.type === 'select') {
            let verified = false;
            while (!verified) {
              this.checkStopped();
              try {
                await waitCondition(page, { kind: 'value', locator: action.locator, value: action.value }, this.inputs, step.timeoutMs);
                verified = true;
              } catch (error) {
                if (this.stopping || this.options.trial) throw error;
                await this.pause({ kind: 'verify', message: 'The field does not contain the requested value. Correct it in the browser, then retry verification.', choices: ['retry', 'stop'] });
              }
            }
            await this.event(`Verified set value: ${step.id} action ${i + 1}`);
            await this.screenshot('value-set');
          }
        }
        delete this.view.actionIndex;
        await this.event(`Waiting for step outcome: ${plan.expect.length} checks (timeout ${step.timeoutMs}ms per check)`);
        if (this.options.trial && !plan.expect.length && plan.actions.some(action => action.type === 'click' || action.type === 'navigate')) throw new Error('Trial requires an explicit postcondition for browser mutations');
        if (!plan.expect.length && plan.actions.some(action => action.type === 'click' || action.type === 'navigate')) {
          await this.pause({ kind: 'verify', message: 'This step has no expected outcome. Confirm in the browser that it completed, then continue. Add plan.expect to verify completion automatically.', choices: ['continue', 'stop'] });
        }
        for (const condition of plan.expect) {
          let verified = false;
          while (!verified) {
            this.checkStopped();
            try { await waitCondition(page, condition, this.inputs, step.timeoutMs); verified = true; }
            catch (error) {
              if (this.stopping || this.options.trial) throw error;
              await this.pause({ kind: 'verify', message: 'Expected outcome was not reached. Inspect or complete the action manually, then retry verification. The action will not be repeated.', choices: ['retry', 'stop'] });
            }
          }
        }
        await this.screenshot('after');
        await this.event(`Step duration: ${Date.now() - stepStarted}ms`);
        if (learned) loaded = await this.store.learn(flow.id, step.id, plan, 'verified', loaded.revision);
        await this.event(`Completed step ${step.id}${plan.expect.length ? ' with outcome checks' : ' (no authored outcome checks)'}`);
      }
      this.checkStopped();
      await close();
      this.checkStopped();
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
  async stopAll() {
    const runs = [...this.runs.values()];
    await Promise.all(runs.map(run => run.stop()));
    await Promise.all(runs.map(run => run.finished));
  }
}
