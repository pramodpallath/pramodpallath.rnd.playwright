import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialOptionsSchema } from '../src/discovery.js';
import { TrialTracker } from '../src/trials.js';

test('requires consecutive full passes after failures', () => {
  const tracker = new TrialTracker(trialOptionsSchema.parse({ successfulRuns: 2, maxAttempts: 4 }));
  tracker.record({ attempt: 1, runId: 'a', status: 'passed' });
  assert.equal(tracker.progress.consecutivePasses, 1);
  tracker.record({ attempt: 2, runId: 'b', status: 'failed', repaired: true });
  assert.equal(tracker.progress.consecutivePasses, 0);
  tracker.record({ attempt: 3, runId: 'c', status: 'passed' });
  tracker.record({ attempt: 4, runId: 'd', status: 'passed' });
  assert.equal(tracker.progress.phase, 'validated');
});
test('bounded attempts and repair budgets', () => {
  const tracker = new TrialTracker(trialOptionsSchema.parse({ successfulRuns: 2, maxAttempts: 3, maxRepairs: 1 }));
  tracker.record({ attempt: 1, runId: 'a', status: 'failed', repaired: true });
  assert.equal(tracker.progress.phase, 'blocked');
});
test('invalid trial budgets rejected', () => {
  assert.equal(trialOptionsSchema.safeParse({ successfulRuns: 5, maxAttempts: 2 }).success, false);
});
