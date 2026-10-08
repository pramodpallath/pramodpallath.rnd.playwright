# Embeddable workflow execution SDK

The runtime executes **compiled YAML**, without calling an LLM to discover selectors.
Use the Discovery Studio to create and validate rules before passing them to the SDK.

```ts
import { WorkflowEngine } from '@appzone/playwright-runtime';
import { readFile } from 'node:fs/promises';

const engine = new WorkflowEngine('./runtime-data');
const yaml = await readFile('./flows/customer-search.yaml', 'utf8');

const handle = await engine.start({
  yaml,
  inputs: { CustomerId: '1002345' },
  onEvent: async event => {
    if (event.type === 'progress') console.log(event.message);
    if (event.type === 'screenshot.captured') console.log(event.url ?? event.artifactPath);
    if (event.type === 'workflow.paused') console.log('Needs user intervention:', event.message);
  },
  // Provide a URL from your own authenticated artifact service.
  resolveArtifactUrl: async file => uploadAndGetSecureUrl(file),
});

const result = await handle.result;
console.log(result.status, result.outputs);
```

## Behavior and limitations

- Each step must already have a validated `plan`. Unresolved steps are rejected.
- Required inputs are checked before browser launch.
- Progress callbacks include step and action identifiers, completed-step counts, and total steps.
- Screenshot callbacks include local artifact paths and an optional caller-provided URL.
- `handle.respond()` resolves a pending manual action; `handle.cancel()` stops the run.
- `handle.result` resolves with status, extracted string outputs, and screenshot references.
- The runtime supports text outputs and structured table extraction (rows, headers, pages visited, completeness).
- The existing runner can pause for user verification; callers must handle `workflow.paused`.
- Callback delivery is best-effort and in-process. It is not a durable webhook or event queue.
- The SDK creates an isolated execution workspace per invocation. Protect and expire these workspaces with an operational retention policy.
- A persistent browser profile is stored under the supplied data directory. Protect it accordingly.
- Screenshot files may contain sensitive information beyond automatically masked fields. Publish only through access-controlled artifact storage.
- Do not run irreversible production operations repeatedly without explicit authorization and reconciliation.

## Data extraction actions

Use `extract-table` for structured tables. Add `next` and `maxPages` to traverse paginated results. A missing or unverified final page is reported as incomplete.

Use `extract-master-data` to save a bounded lookup dataset under the execution workspace's `master-data` directory. The `MasterDataRegistry` API supports reading and resolving labels to codes. Extraction never treats an incomplete dataset as complete.

Custom comboboxes use `select-combobox` with a target, an option locator, and an explicit expected selected value. A selection is considered successful only after verification.

## Production deployment requirements

The SDK is not a hosted, durable orchestration service. Before deploying to production, provide an authenticated artifact backend, callback delivery persistence/retries, retention/cleanup, tenant and identity isolation, permission controls, secret management, observability, and representative browser integration tests. SSO and irreversible workflows require human-in-the-loop policies. No production readiness claim is made until those checks pass.
