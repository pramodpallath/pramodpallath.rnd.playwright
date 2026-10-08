import { interpolate } from '../schema.js';
import { ensureFillAllowed } from '../browser/sensitive-controls.js';
import { waitCondition } from '../browser/conditions.js';
import type { ActionAdapter } from './contract.js';
import { visibleTarget } from './target.js';

export const fill: ActionAdapter<'fill'> = (action, context) => ({
  retryAfterDispatch: true,
  requiresStepOutcome: false,
  evidence: 'value-set',
  async prepare() {
    const value = interpolate(action.value, context.inputs);
    const target = await visibleTarget(context, action.locator);
    // Policy checks the authored placeholder, never the resolved secret.
    await ensureFillAllowed(target, action.value);
    return { execute: async () => { await target.fill(value); } };
  },
  verify: () => waitCondition(context.page,
    { kind: 'value', locator: action.locator, value: action.value }, context.inputs, context.timeoutMs),
});
