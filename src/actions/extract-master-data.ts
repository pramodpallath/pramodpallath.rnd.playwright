import { extractTable } from '../controls.js';
import { ensureNonSecret } from '../browser/sensitive-controls.js';
import type { ActionAdapter } from './contract.js';
import { visibleTarget } from './target.js';

export const extractMasterData: ActionAdapter<'extract-master-data'> = (action, context) => ({
  retryAfterDispatch: true,
  requiresStepOutcome: false,
  async prepare() {
    await ensureNonSecret(await visibleTarget(context, action.locator));
    return { execute: async () => {
      const extracted = await extractTable(context.page, action.locator, action);
      await context.saveMasterData({
        id: action.registry,
        sourceWorkflow: context.flowId,
        capturedAt: new Date().toISOString(),
        complete: extracted.complete,
        pagesVisited: extracted.pagesVisited,
        keyColumn: action.valueColumn,
        labelColumn: action.labelColumn,
        records: extracted.rows.map(row => {
          if (!Object.hasOwn(row, action.valueColumn) || !Object.hasOwn(row, action.labelColumn))
            throw new Error('Master data column mapping does not match the extracted table');
          return { value: row[action.valueColumn], label: row[action.labelColumn] };
        }),
      });
      return { message: `Master data ${action.registry} captured: ${extracted.rows.length} records, complete=${extracted.complete}` };
    } };
  },
});
