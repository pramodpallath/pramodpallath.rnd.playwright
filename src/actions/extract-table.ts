import { extractTable } from '../controls.js';
import { ensureNonSecret } from '../browser/sensitive-controls.js';
import type { ActionAdapter } from './contract.js';
import { visibleTarget } from './target.js';

export const extractTableAction: ActionAdapter<'extract-table'> = (action, context) => ({
  retryAfterDispatch: true,
  requiresStepOutcome: false,
  async prepare() {
    await ensureNonSecret(await visibleTarget(context, action.locator));
    return { execute: async () => ({ output: {
      name: action.output,
      value: await extractTable(context.page, action.locator, action),
    } }) };
  },
});
