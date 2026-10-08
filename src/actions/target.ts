import type { LocatorSpec } from '../schema.js';
import { locate, unique } from '../browser/locators.js';
import type { ActionContext } from './contract.js';

export async function visibleTarget(context: ActionContext, spec: LocatorSpec) {
  const target = locate(context.page, spec);
  await target.waitFor({ state: 'visible', timeout: context.timeoutMs });
  await unique(target);
  return target;
}
