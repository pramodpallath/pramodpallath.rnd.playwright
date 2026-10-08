import { waitCondition } from '../browser/conditions.js';
import type { ActionAdapter } from './contract.js';

export const wait: ActionAdapter<'wait'> = (action, context) => ({
  retryAfterDispatch: true,
  requiresStepOutcome: false,
  async prepare() {
    return { execute: () => waitCondition(context.page, action.condition, context.inputs, context.timeoutMs) };
  },
});
