import { ensureNonSecret } from '../browser/sensitive-controls.js';
import type { ActionAdapter } from './contract.js';
import { visibleTarget } from './target.js';

export const extract: ActionAdapter<'extract'> = (action, context) => ({
  retryAfterDispatch: true,
  requiresStepOutcome: false,
  async prepare() {
    const target = await visibleTarget(context, action.locator);
    await ensureNonSecret(target);
    return { execute: async () => ({ output: {
      name: action.output,
      value: action.source === 'value' ? await target.inputValue() : (await target.innerText()).trim(),
    } }) };
  },
});
