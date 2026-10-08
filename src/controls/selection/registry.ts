import { nativeSelect } from './native-select.js';
import { authoredCombobox } from './authored-combobox.js';
import type { SelectionAdapter, SelectionContext, SelectionControl, SelectionSpec } from './contract.js';

type Registry = { [K in SelectionSpec['adapter']]: SelectionAdapter<K> };
const adapters: Registry = {
  'native-select': nativeSelect,
  'authored-combobox': authoredCombobox,
};

export function resolveSelection(spec: SelectionSpec, context: SelectionContext): SelectionControl {
  // The discriminant selects the matching parameter type; the mapped registry
  // checks every entry. Keep this correlation assertion at the dispatch seam.
  const adapter = adapters[spec.adapter] as (spec: SelectionSpec, context: SelectionContext) => SelectionControl;
  return adapter(spec, context);
}
