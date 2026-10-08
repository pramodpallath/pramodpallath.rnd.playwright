import { locate, unique } from '../../browser/locators.js';
import { ensureNonSecret } from '../../browser/sensitive-controls.js';
import type { SelectionAdapter } from './contract.js';

/** Explicit option locators preserve the saved select-combobox contract.
 * No guessed ARIA relationships and no fallback after a partial interaction.
 */
export const authoredCombobox: SelectionAdapter<'authored-combobox'> = (spec, context) => {
  const trigger = locate(context.page, spec.locator);
  return {
    async prepare() {
      await trigger.waitFor({ state: 'visible', timeout: context.timeoutMs });
      await unique(trigger);
      await ensureNonSecret(trigger);
    },
    async select(_value) {
      await trigger.click();
      const option = locate(context.page, spec.option);
      await option.waitFor({ state: 'visible', timeout: context.timeoutMs });
      await unique(option);
      await option.click();
    },
    async verify(value) {
      const selected = spec.verify ? locate(context.page, spec.verify) : trigger;
      await selected.waitFor({ state: 'visible', timeout: context.timeoutMs });
      await unique(selected);
      const actual = await selected.evaluate(element =>
        element instanceof HTMLInputElement || element instanceof HTMLSelectElement
          ? element.value : (element.textContent ?? '').trim());
      if (actual !== value) throw new Error('Combobox selection was not verified');
    },
  };
};
