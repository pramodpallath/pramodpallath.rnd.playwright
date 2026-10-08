import { locate, unique } from '../../browser/locators.js';
import { ensureNonSecret } from '../../browser/sensitive-controls.js';
import { waitCondition } from '../../browser/conditions.js';
import type { SelectionAdapter } from './contract.js';

export const nativeSelect: SelectionAdapter<'native-select'> = (spec, context) => {
  const target = locate(context.page, spec.locator);
  return {
    async prepare() {
      await target.waitFor({ state: 'visible', timeout: context.timeoutMs });
      await unique(target);
      await ensureNonSecret(target);
      if (!await target.evaluate(element => element.tagName === 'SELECT'))
        throw new Error('Native selection requires a select element; author a select-combobox action for custom controls');
    },
    async select(value) { await target.selectOption(value); },
    verify: value => waitCondition(context.page,
      { kind: 'value', locator: spec.locator, value: '{SelectedValue}' },
      { SelectedValue: value }, context.timeoutMs ?? 30000),
  };
};
