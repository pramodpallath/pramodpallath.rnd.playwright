import { resolveSelection } from './controls/selection/registry.js';
import type { Page } from 'playwright';
import { locate, unique } from './browser/locators.js';
import { ensureNonSecret } from './browser/sensitive-controls.js';
import type { LocatorSpec } from './schema.js';

export type TableRow = Record<string, string>;
export type TableExtraction = {
  rows: TableRow[];
  pagesVisited: number;
  complete: boolean;
  headers: string[];
};

/**
 * Reads semantic tables, including a bounded sequence of paginated result sets.
 * A table is complete only if pagination is absent or its Next control is disabled.
 */
export async function extractTable(
  page: Page,
  tableSpec: LocatorSpec,
  options: { next?: LocatorSpec; maxPages: number; maxRows: number },
): Promise<TableExtraction> {
  const rows: TableRow[] = [];
  const seen = new Set<string>();
  let headers: string[] = [];
  let complete = !options.next;
  let pagesVisited = 0;

  for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber++) {
    const table = locate(page, tableSpec);
    await table.waitFor({ state: 'visible' });
    await unique(table);
    await ensureNonSecret(table);

    const current = await table.evaluate(element => {
      const headerRow = element.querySelector('thead tr') ?? element.querySelector('tr:has(th)');
      // Keep callbacks self-contained: tsx's named-function helper is not
      // available inside Playwright's serialized browser execution context.
      const headers = headerRow ? [...headerRow.querySelectorAll(':scope > th, :scope > td')]
        .map(cell => (cell.textContent ?? '').trim()) : [];
      const bodyRows = [...element.querySelectorAll('tbody tr')];
      const dataRows = bodyRows.length ? bodyRows : [...element.querySelectorAll('tr')].filter(row => row !== headerRow);
      return { headers, rows: dataRows.map(row => [...row.querySelectorAll(':scope > th, :scope > td')]
        .map(cell => (cell.textContent ?? '').trim())) };
    });
    if (!headers.length) headers = current.headers;
    if (!headers.length) throw new Error('Table has no column headers; author explicit columns before extraction');
    if (headers.some(header => !header) || new Set(headers).size !== headers.length)
      throw new Error('Table headers must be non-empty and unique');
    if (current.headers.join('|') !== headers.join('|')) throw new Error('Table headers changed during pagination');
    for (const cells of current.rows) {
      if (cells.length !== headers.length) throw new Error('Table row does not match header count');
      const row = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
      const key = JSON.stringify(cells);
      if (seen.has(key)) continue;
      if (rows.length >= options.maxRows) throw new Error('Table extraction row limit reached; results are incomplete');
      seen.add(key);
      rows.push(row);
    }
    pagesVisited++;
    if (!options.next) break;
    const next = locate(page, options.next);
    if (await next.count() === 0 || !await next.isVisible() || !await next.isEnabled()) {
      complete = true;
      break;
    }
    await unique(next);
    await next.click();
    let changed = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const snapshot = await locate(page, tableSpec).evaluate(element => {
        const rows = [...element.querySelectorAll('tbody tr')];
        return rows.map(row => [...row.querySelectorAll(':scope > th, :scope > td')]
          .map(cell => (cell.textContent ?? '').trim()));
      }).catch(() => [] as string[][]);
      if (JSON.stringify(snapshot) !== JSON.stringify(current.rows)) {
        changed = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!changed) throw new Error('Pagination did not advance; extraction is incomplete');

  }
  return { rows, headers, pagesVisited, complete };
}

/** Compatibility entry point for callers outside the action runtime. */
export async function selectCombobox(
  page: Page, control: LocatorSpec, option: LocatorSpec, value: string, verify?: LocatorSpec,
): Promise<void> {
  const adapter = resolveSelection({ adapter: 'authored-combobox', locator: control, option, verify },
    { page });
  await adapter.prepare();
  await adapter.select(value);
  await adapter.verify(value);
}
