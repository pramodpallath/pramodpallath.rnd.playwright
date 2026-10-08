import type { ActionAdapter } from './contract.js';
import { visibleTarget } from './target.js';

export const check: ActionAdapter<'check'> = (action, context) => ({
  retryAfterDispatch: true,
  requiresStepOutcome: false,
  async prepare() {
    const target = await visibleTarget(context, action.locator);
    return { execute: async () => { await target.setChecked(action.checked); } };
  },
});
