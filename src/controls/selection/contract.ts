import type { Page } from 'playwright';
import type { LocatorSpec } from '../../schema.js';

export type SelectionSpec =
  | { adapter: 'native-select'; locator: LocatorSpec }
  | { adapter: 'authored-combobox'; locator: LocatorSpec; option: LocatorSpec; verify?: LocatorSpec };

export interface SelectionContext {
  page: Page;
  timeoutMs?: number;
}

/** A capability shared by selection implementations, not by every control. */
export interface SelectionControl {
  prepare(): Promise<void>;
  select(value: string): Promise<void>;
  verify(value: string): Promise<void>;
}

export type SelectionAdapter<K extends SelectionSpec['adapter']> =
  (spec: Extract<SelectionSpec, { adapter: K }>, context: SelectionContext) => SelectionControl;
