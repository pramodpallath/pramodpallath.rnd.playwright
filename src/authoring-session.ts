import { randomUUID } from 'node:crypto';
import { openProfile } from './browser.js';
import type { Page, BrowserContext } from 'playwright';
import { discoverPageModel, type PageModel, PageModelStore } from './page-model.js';
import { locate, unique } from './browser.js';
import { planSchema, type Plan } from './schema.js';
import { ensureFillAllowed, ensureNonSecret } from './browser.js';

export class AuthoringSession {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  private lastActivity = Date.now();
  private current: Page;
  private constructor(readonly context: BrowserContext, page: Page, private readonly closeProfile: () => Promise<void>) {
    this.current = page;
  }
  static async open(dataDir: string, profile: string, url: string, headless: boolean): Promise<AuthoringSession> {
    const browser = await openProfile(dataDir, profile, headless);
    try {
      await browser.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return new AuthoringSession(browser.context, browser.page, browser.close);
    } catch (error) { await browser.close(); throw error; }
  }
  get page() {
    this.lastActivity = Date.now();
    if (this.current.isClosed()) {
      const live = this.context.pages().filter(p => !p.isClosed());
      if (live.length !== 1) throw new Error('Browser page closed or multiple tabs need explicit selection');
      this.current = live[0];
    }
    return this.current;
  }
  get idleMs() { return Date.now() - this.lastActivity; }
  async discover(modelId: string, store: PageModelStore): Promise<PageModel> {
    return store.save(await discoverPageModel(this.page, modelId));
  }
  async execute(plan: Plan): Promise<void> {
    const parsed = planSchema.parse(plan);
    if (parsed.actions.length !== 1) throw new Error('Authoring preview accepts exactly one action');
    const action = parsed.actions[0];
    if (!('locator' in action) || !['click', 'fill', 'check', 'select'].includes(action.type))
      throw new Error('Unsupported preview action');
    const page = this.page;
    const locator = locate(page, action.locator);
    await unique(locator);
    if (action.type === 'fill') await ensureFillAllowed(locator, action.value);
    if (action.type === 'select') await ensureNonSecret(locator);
    if (action.type === 'click') await locator.click();
    else if (action.type === 'fill') await locator.fill(action.value);
    else if (action.type === 'select') await locator.selectOption(action.value);
    else if (action.type === 'check') await locator.setChecked(action.checked);
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    const pages = this.context.pages().filter(p => !p.isClosed());
    if (pages.length === 1) this.current = pages[0];
    else if (pages.length > 1) throw new Error('Multiple tabs open; select a tab before continuing');
  }
  async close() { await this.closeProfile(); }
}
