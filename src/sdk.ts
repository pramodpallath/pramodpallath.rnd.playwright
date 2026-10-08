import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { flowSchema, instructionInputs } from './schema.js';
import { FlowStore } from './store.js';
import { Runner, type RunView, type Screenshot } from './runner.js';

export type WorkflowEvent =
  | { type: 'workflow.started'; runId: string; workflowId: string }
  | { type: 'progress'; runId: string; workflowId: string; stepId?: string; actionIndex?: number; message: string; completedSteps: number; totalSteps: number }
  | { type: 'screenshot.captured'; runId: string; workflowId: string; stepId: string; phase: Screenshot['phase']; artifactPath: string; url?: string }
  | { type: 'workflow.paused'; runId: string; workflowId: string; message: string }
  | { type: 'workflow.finished'; runId: string; workflowId: string; status: RunView['status'] };

export type WorkflowResult = {
  runId: string;
  workflowId: string;
  status: RunView['status'];
  outputs: Record<string, string>;
  screenshots: Array<{ stepId: string; phase: Screenshot['phase']; artifactPath: string; url?: string }>;
};

export type ExecuteOptions = {
  yaml: string;
  inputs?: Record<string, string>;
  headless?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: WorkflowEvent) => void | Promise<void>;
  /** Publish an authenticated URL for an artifact; no URL is invented by the SDK. */
  resolveArtifactUrl?: (artifactPath: string) => string | Promise<string>;
};

export type ExecutionHandle = {
  runId: string;
  result: Promise<WorkflowResult>;
  respond: (decision: 'continue' | 'retry' | 'done' | 'stop', value?: string) => void;
  cancel: () => Promise<void>;
};

/**
 * Embeddable executor for precompiled workflows.
 *
 * The SDK deliberately rejects unresolved steps: LLM discovery and rule
 * mutation belong to Discovery Studio, not the production runtime.
 */
export class WorkflowEngine {
  constructor(private readonly dataDir: string) {}

  async start(options: ExecuteOptions): Promise<ExecutionHandle> {
    const document = parseDocument(options.yaml);
    if (document.errors.length) throw new Error(document.errors[0].message);
    const flow = flowSchema.parse(document.toJS());
    if (flow.steps.some(step => !step.plan)) throw new Error('Execution requires a compiled plan for every step');
    const inputs = options.inputs ?? {};
    const required = Object.entries(instructionInputs(flow))
      .filter(([name, definition]) => definition.required && !inputs[name])
      .map(([name]) => name);
    if (required.length) throw new Error(`Missing required inputs: ${required.join(', ')}`);

    const flowsDir = path.join(this.dataDir, 'flows');
    await mkdir(flowsDir, { recursive: true, mode: 0o700 });
    const store = new FlowStore(flowsDir);
    const existing = await store.read(flow.id).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    // The SDK never overwrites a workflow that is being used by another caller.
    if (existing) throw new Error(`Workflow ${flow.id} already exists in this execution workspace; use an isolated dataDir`);
    await store.save(flow.id, options.yaml, null);

    const runner = new Runner(store, this.dataDir);
    const run = runner.start(flow.id, { inputs, headless: options.headless });
    const { id: runId } = run.view;
    let eventCursor = 0;
    let screenshotCursor = 0;
    let pauseMarker = '';
    const screenshots: WorkflowResult['screenshots'] = [];
    const deliver = async (event: WorkflowEvent) => {
      // Event handlers cannot change browser execution outcomes.
      try { await options.onEvent?.(event); }
      catch { /* A caller can implement durable retries in its own event transport. */ }
    };
    const flush = async () => {
      for (const event of run.view.events.slice(eventCursor)) {
        await deliver({
          type: 'progress', runId, workflowId: flow.id,
          stepId: event.stepId, actionIndex: event.actionIndex,
          message: event.message,
          completedSteps: run.view.events.filter(e => e.message.startsWith('Completed step ')).length,
          totalSteps: flow.steps.length,
        });
      }
      eventCursor = run.view.events.length;
      for (const screenshot of run.view.screenshots.slice(screenshotCursor)) {
        const artifactPath = path.join(this.dataDir, 'runs', runId, screenshot.file);
        let url: string | undefined;
        try { url = await options.resolveArtifactUrl?.(artifactPath); }
        catch { /* Artifact remains accessible via its local path. */ }
        screenshots.push({ stepId: screenshot.stepId, phase: screenshot.phase, artifactPath, url });
        await deliver({ type: 'screenshot.captured', runId, workflowId: flow.id,
          stepId: screenshot.stepId, phase: screenshot.phase, artifactPath, url });
      }
      screenshotCursor = run.view.screenshots.length;
      const marker = JSON.stringify(run.view.pause ?? null);
      if (run.view.pause && marker !== pauseMarker) await deliver({
        type: 'workflow.paused', runId, workflowId: flow.id, message: run.view.pause.message,
      });
      pauseMarker = marker;
    };
    const result = (async (): Promise<WorkflowResult> => {
      await deliver({ type: 'workflow.started', runId, workflowId: flow.id });
      while (run.view.status === 'running' || run.view.status === 'paused') {
        if (options.signal?.aborted) await run.stop();
        await flush();
        if (run.view.status === 'running' || run.view.status === 'paused')
          await new Promise(resolve => setTimeout(resolve, 150));
      }
      await run.finished;
      await flush();
      await deliver({ type: 'workflow.finished', runId, workflowId: flow.id, status: run.view.status });
      return { runId, workflowId: flow.id, status: run.view.status,
        outputs: { ...run.view.outputs }, screenshots };
    })();
    return {
      runId, result,
      respond: (decision, value) => run.respond(decision, value),
      cancel: () => run.stop(),
    };
  }

  async execute(options: ExecuteOptions): Promise<WorkflowResult> {
    return (await this.start(options)).result;
  }
}
