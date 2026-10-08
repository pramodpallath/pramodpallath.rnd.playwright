import type { Page } from 'playwright';
import type { Action } from '../schema.js';
import type { TableExtraction } from '../controls.js';
import type { MasterDataSet } from '../master-data.js';

export type BrowserAction = Exclude<Action, { type: 'ask-user' }>;
export type ActionOf<K extends BrowserAction['type']> = Extract<BrowserAction, { type: K }>;

/** Dependencies available to actions; no access to mutable run state. */
export interface ActionContext {
  page: Page;
  inputs: Readonly<Record<string, string>>;
  timeoutMs: number;
  flowId: string;
  saveMasterData(dataset: MasterDataSet): Promise<void>;
}

export interface ActionResult {
  output?: { name: string; value: string | TableExtraction };
  message?: string;
}

export interface PreparedAction {
  execute(): Promise<ActionResult | void>;
}

export interface BoundAction {
  /** Preparation may inspect the page, but must not dispatch the action. */
  prepare(): Promise<PreparedAction>;
  /** Separate from execution so manual correction never repeats the mutation. */
  verify?: () => Promise<void>;
  controlAdapter?: string;
  evidence?: 'value-set';
  /** Existing replay policy. Repeatable does not mean free of side effects. */
  retryAfterDispatch: boolean;
  requiresStepOutcome: boolean;
}

export type ActionAdapter<K extends BrowserAction['type']> =
  (action: ActionOf<K>, context: ActionContext) => BoundAction;
