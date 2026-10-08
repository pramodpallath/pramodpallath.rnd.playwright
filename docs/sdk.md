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
- The current runner stores extracted outputs as strings. Structured table extraction is planned separately.
- The existing runner can pause for user verification; callers must handle `workflow.paused`.
- Callback delivery is best-effort and in-process. It is not a durable webhook or event queue.
- Use a separate `dataDir` per concurrent SDK instance to avoid workflow file collisions.
- A persistent browser profile is stored under the supplied data directory. Protect it accordingly.
- Screenshot files may contain sensitive information beyond automatically masked fields. Publish only through access-controlled artifact storage.
- Do not run irreversible production operations repeatedly without explicit authorization and reconciliation.
