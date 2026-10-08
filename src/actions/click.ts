import type { ActionAdapter } from './contract.js';
import { visibleTarget } from './target.js';

export const click: ActionAdapter<'click'> = (action, context) => ({
  retryAfterDispatch: false,
  requiresStepOutcome: true,
  async prepare() {
    const target = await visibleTarget(context, action.locator);
    await target.click({ trial: true });
    return { execute: async () => { await target.click(); } };
  },
});
