import { interpolate } from '../schema.js';
import type { ActionAdapter } from './contract.js';

export const navigate: ActionAdapter<'navigate'> = (action, context) => ({
  retryAfterDispatch: false,
  requiresStepOutcome: true,
  async prepare() {
    const url = interpolate(action.url, context.inputs);
    return { execute: async () => {
      await context.page.goto(url, { waitUntil: 'load', timeout: context.timeoutMs });
    } };
  },
});
