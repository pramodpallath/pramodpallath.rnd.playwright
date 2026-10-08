import type { ActionAdapter, ActionContext, BoundAction, BrowserAction } from './contract.js';
import { click } from './click.js';
import { fill } from './fill.js';
import { navigate } from './navigate.js';
import { check } from './check.js';
import { wait } from './wait.js';
import { extract } from './extract.js';
import { extractTableAction } from './extract-table.js';
import { extractMasterData } from './extract-master-data.js';
import { select, selectCombobox } from './select.js';

type Registry = { [K in BrowserAction['type']]: ActionAdapter<K> };
const adapters: Registry = {
  click, fill, navigate, check, wait, extract, select,
  'select-combobox': selectCombobox,
  'extract-table': extractTableAction,
  'extract-master-data': extractMasterData,
};

export function bindAction(action: BrowserAction, context: ActionContext): BoundAction {
  // TypeScript loses the discriminant/parameter correlation at dynamic lookup.
  // The mapped registry checks completeness and each adapter's action type.
  const adapter = adapters[action.type] as (action: BrowserAction, context: ActionContext) => BoundAction;
  return adapter(action, context);
}
