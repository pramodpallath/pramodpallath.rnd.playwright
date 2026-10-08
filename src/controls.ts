import type { Page } from 'playwright';
import { locate, unique, ensureNonSecret } from './browser.js';
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
      const cells = (row: Element) => [...row.querySelectorAll(':scope > th, :scope > td')]
        .map(cell => (cell.textContent ?? '').trim());
      const headerRow = element.querySelector('thead tr') ?? element.querySelector('tr:has(th)');
      const headers = headerRow ? cells(headerRow) : [];
      const bodyRows = [...element.querySelectorAll('tbody tr')];
      const dataRows = bodyRows.length ? bodyRows : [...element.querySelectorAll('tr')].filter(row => row !== headerRow);
      return { headers, rows: dataRows.map(cells) };
    });
    if (!headers.length) headers = current.headers;
    if (!headers.length) throw new Error('Table has no column headers; author explicit columns before extraction');
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

/** Custom comboboxes must commit a real option, not merely fill the search text. */
export async function selectCombobox(
  page: Page, control: LocatorSpec, option: LocatorSpec, value: string, verify?: LocatorSpec,
): Promise<void> {
  const trigger = locate(page, control);
  await trigger.waitFor({ state: 'visible' });
  await unique(trigger);
  await ensureNonSecret(trigger);
  await trigger.click();
  const target = locate(page, option);
  await target.waitFor({ state: 'visible' });
  await unique(target);
  await target.click();
  const selected = verify ? locate(page, verify) : trigger;
  await selected.waitFor({ state: 'visible' });
  await unique(selected);
  const actual = await selected.evaluate(element =>
    element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      ? element.value : (element.textContent ?? '').trim());
  if (actual !== value) throw new Error('Combobox selection was not verified');
}
