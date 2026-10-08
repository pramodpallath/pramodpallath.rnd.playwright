import { interpolate } from '../schema.js';
import { resolveSelection } from '../controls/selection/registry.js';
import type { ActionAdapter } from './contract.js';

export const select: ActionAdapter<'select'> = (action, context) => {
  const control = resolveSelection({ adapter: 'native-select', locator: action.locator }, context);
  return {
    retryAfterDispatch: true,
    requiresStepOutcome: false,
    controlAdapter: 'native-select',
    evidence: 'value-set',
    async prepare() {
      const value = interpolate(action.value, context.inputs);
      await control.prepare();
      return { execute: async () => { await control.select(value); } };
    },
    verify: () => control.verify(interpolate(action.value, context.inputs)),
  };
};

export const selectCombobox: ActionAdapter<'select-combobox'> = (action, context) => {
  const control = resolveSelection({ adapter: 'authored-combobox', ...action }, context);
  return {
    retryAfterDispatch: true,
    requiresStepOutcome: false,
    controlAdapter: 'authored-combobox',
    async prepare() {
      const value = interpolate(action.value, context.inputs);
      await control.prepare();
      return { execute: async () => {
        await control.select(value);
        // Preserve the existing composite action's failure/recovery behavior.
        await control.verify(value);
      } };
    },
  };
};
