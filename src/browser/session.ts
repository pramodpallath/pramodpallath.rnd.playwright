import { chromium, type BrowserContext } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { acquireProfileLock } from '../profile-lock.js';

const profileCleanup = new Map<string, Promise<void>>();

export async function openProfile(dataDir: string, profile: string, headless = false) {
  const directory = path.resolve(dataDir, 'profiles', profile);
  await profileCleanup.get(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireProfileLock(directory, profile);
  const release = () => {
    const cleanup = releaseLock();
    profileCleanup.set(directory, cleanup);
    void cleanup.finally(() => {
      if (profileCleanup.get(directory) === cleanup) profileCleanup.delete(directory);
    }).catch(() => {});
    return cleanup;
  };
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(directory, { headless, viewport: { width: 1280, height: 850 } });
  } catch (error) { await release(); throw error; }
  context.once('close', () => { void release().catch(() => {}); });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    let closing: Promise<void> | undefined;
    return {
      context, page,
      close: () => closing ??= (async () => { try { await context.close(); } finally { await release(); } })(),
    };
  } catch (error) { await context.close(); await release(); throw error; }
}

