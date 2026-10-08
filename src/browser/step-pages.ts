import type { Page, BrowserContext } from 'playwright';

// Select at step boundaries so a click's own outcome checks stay on its page.
// Only pages opened during this run can become the next step's target.
export class StepPages {
  private seen: Set<Page>;
  private current: Page;
  private initialUrl: string;
  constructor(private context: BrowserContext, private initial: Page) {
    this.current = initial;
    this.initialUrl = initial.url();
    this.seen = new Set(context.pages());
  }

  // Authentication popups belong to the manual action; subsequent steps stay on
  // the application whose completion conditions were verified.
  retainApplication(page: Page) {
    this.current = page;
    for (const opened of this.context.pages()) this.seen.add(opened);
  }

  async select(instruction: string, timeoutMs: number): Promise<Page> {
    const requestsNewPage = /\b(?:in|on|within|to)\s+(?:(?:the|a|this|that)\s+)?(?:new\s+(?:browser\s+)?(?:page|tab|window)\b|newly\s+opened\s+(?:page|tab|window)\b|pop[ -]?up\b)/i.test(instruction);
    let candidates = this.context.pages().filter(page => !page.isClosed() && !this.seen.has(page));
    // A same-tab navigation also satisfies "the new page". Once selected,
    // a popup stays active for subsequent steps that refer to that page.
    if (!candidates.length && requestsNewPage && this.current === this.initial && this.current.url() === this.initialUrl) {
      try {
        await this.context.waitForEvent('page', { timeout: timeoutMs });
      } catch {
        throw new Error('No new page opened before the step timeout');
      }
      candidates = this.context.pages().filter(page => !page.isClosed() && !this.seen.has(page));
    }
    if (candidates.length > 1) throw new Error('Multiple new pages opened; the next step target is ambiguous');
    if (candidates.length === 1) this.current = candidates[0];
    if (this.current.isClosed()) throw new Error('The active page was closed; stop and restart the flow');
    await this.current.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
    for (const page of candidates) this.seen.add(page);
    return this.current;
  }
}

