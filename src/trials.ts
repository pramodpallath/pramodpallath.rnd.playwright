import type { TrialOptions } from './discovery.js';

export type TrialRecord = { attempt: number; runId: string; status: 'passed' | 'failed' | 'stopped'; failedStep?: string; repaired?: boolean };
export type TrialProgress = {
  phase: 'trialing' | 'repairing' | 'validated' | 'blocked';
  required: number;
  consecutivePasses: number;
  repairs: number;
  attempts: TrialRecord[];
};

/** Explicit limits prevent unbounded autonomous retries. */
export class TrialTracker {
  readonly progress: TrialProgress;
  constructor(readonly options: TrialOptions) {
    this.progress = { phase: 'trialing', required: options.successfulRuns, consecutivePasses: 0, repairs: 0, attempts: [] };
  }
  record(record: TrialRecord) {
    this.progress.attempts.push(record);
    this.progress.consecutivePasses = record.status === 'passed' ? this.progress.consecutivePasses + 1 : 0;
    if (record.repaired) this.progress.repairs++;
    if (this.progress.consecutivePasses >= this.options.successfulRuns) this.progress.phase = 'validated';
    else if (record.status === 'stopped' || this.progress.attempts.length >= this.options.maxAttempts) this.progress.phase = 'blocked';
    else if (record.status === 'failed' && (!this.options.autoRepair || this.progress.repairs >= this.options.maxRepairs)) this.progress.phase = 'blocked';
    else this.progress.phase = 'trialing';
    return this.progress;
  }
}
