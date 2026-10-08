import { mkdir, open, readFile, readlink, rmdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    // Only ESRCH proves a process has exited; permission failures are not proof.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function verifyChromiumStopped(directory: string) {
  let owner: string;
  try { owner = await readlink(path.join(directory, 'SingletonLock')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const match = /^(.*)-(\d+)$/.exec(owner);
  if (!match || match[1] !== os.hostname()) throw new Error('Chromium profile owner cannot be verified on this host; leave its lock intact');
  if (alive(Number(match[2]))) throw new Error(`Chromium PID ${match[2]} is still running for this profile; close that browser before retrying`);
}

export async function acquireProfileLock(directory: string, profile: string) {
  const lockPath = path.join(directory, '.flow-run.lock');
  const busy = (owner?: string) => new Error(`Profile '${profile}' is already in use${owner ? ` by PID ${owner}` : ''}. Stop its existing run before starting another.`);
  const create = () => open(lockPath, 'wx', 0o600);
  const lock = await create().catch(async error => {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale recovery. Never unlink an unverified or live owner's lock.
    // If recovery itself is killed, retain this guard for manual inspection.
    const guard = path.join(directory, '.flow-run.recovery');
    try { await mkdir(guard, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy(); throw error; }
    try {
      let owner: string;
      try { owner = (await readFile(lockPath, 'utf8')).trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return await create(); throw error; }
      if (!/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))) throw new Error(`Profile '${profile}' has an invalid lock owner; leave its lock intact for inspection`);
      if (alive(Number(owner))) throw busy(owner);
      await verifyChromiumStopped(directory);
      await unlink(lockPath);
      // A non-recovering contender may win creation; wx still protects ownership.
      return await create().catch(error => { if (error.code === 'EEXIST') throw busy(); throw error; });
    } finally { await rmdir(guard); }
  });
  const identity = await lock.stat();
  let released: Promise<void> | undefined;
  const release = () => released ??= (async () => {
    try {
      const current = await stat(lockPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (current?.ino === identity.ino && current.dev === identity.dev) await unlink(lockPath);
    } finally { await lock.close(); }
  })();
  try { await lock.writeFile(String(process.pid)); }
  catch (error) { await release(); throw error; }
  return release;
}
