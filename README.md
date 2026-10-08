# pramodpallath.rnd.playwright

In Flow Studio, write `Set username to {UserName}` in a step and save it.
The Execution panel creates a `UserName` input field automatically. Enter its
value there before clicking **Run flow** or **Repair & run**. Required inputs
are checked before starting. Names are case-sensitive. Values are not saved in
YAML. Use `{Password}` to fill a password from the masked Password input;
OTPs and PINs must be entered directly in the browser.

After each fill or selection, the runner checks that the field contains the
requested value, records verification, and captures a **value-set** screenshot
before the next action. A mismatch pauses for correction and re-verification.
Screenshots display ordinary fields such as username; sensitive controls
(including passwords, OTPs, PINs and payment fields) remain masked, also in
frames. Input values remain redacted from logs and are not saved in YAML.

You can also declare inputs explicitly in YAML:

```yaml
inputs:
  Username:
    required: true
steps:
  - id: open-login
    instruction: Click Login
  - id: username
    instruction: Set Username as {Username} in the new page that is opened
```

Supply `Pramodpv` as the `Username` input. Put the action that opens the page
and the action that fills it in separate steps. At the next step, the runner
switches to a single newly opened tab or popup and waits for its document to
load before resolving or replaying its plan. Later steps keep using that page.
Instructions referring to a new page also wait for a delayed popup, up to the
step's `timeoutMs`; same-tab navigation continues on the current page.

The opening step's outcome checks still run on the opening page. Multiple new
pages, a missing requested popup, or a closed active page stop the run with an
explanation. Password fills use `{Password}`; other sensitive fields require
manual entry. Password values remain masked in screenshots and redacted in logs.

Each finished flow closes its browser, including all tabs and popups, before
reporting completion. Failed and stopped runs also close the browser. A paused
run keeps it open for manual input or verification. Saved profile data remains
available for the next run.

Profile locks are released when the browser closes, when a run finishes, and
during graceful SIGINT/SIGTERM shutdown. After a crash, the next run recovers a
stale `.flow-run.lock` only when its recorded PID has exited and Chromium's
recorded profile owner is also confirmed stopped. A live owner still blocks a
second run: stop the existing run or use a different profile for concurrent
flows. Prefer the Stop button or Ctrl+C when restarting.

An invalid lock owner, an unverifiable Chromium owner, or an interrupted
recovery (`.flow-run.recovery` exists) requires inspection rather than automatic
deletion. Profile data is retained during recovery.

Run activity and CLI log lines start with numeric Unix timestamps in
microseconds. New run IDs and their folder names use the same timestamp:
`.data/runs/<timestamp>/`. The run event log is `.data/runs/<timestamp>.jsonl`.
Each LLM request, response, or error is a separate, pretty-printed JSON file
inside that run folder, named `<timestamp>-llm-<phase>.json`. Timestamps use
the high-resolution clock and increase for successive entries, so filenames
sort chronologically. Open individual LLM files from Run activity. Input
values and API keys remain redacted. Older run folders and logs remain
accessible from saved run history.

Browser `ask-user` actions can skip the prompt or resume automatically when all
`until` conditions hold together on the application page:

```yaml
steps:
  - id: sign-in
    instruction: Complete sign-in manually and wait for the authenticated app
    timeoutMs: 300000
    plan:
      actions:
        - type: ask-user
          mode: browser
          prompt: Complete sign-in and MFA in the browser.
          graceMs: 1500
          until:
            - kind: origin
              value: https://your-app.example
            - kind: visible
              locator:
                target:
                  by: testId
                  value: authenticated-home
      expect: []
```

Replace the example origin and locator with verified application values.
`flows/azure-portal.yaml` uses `https://portal.azure.com` plus the supplied
"Welcome back" text marker, allowing a name after that text, and gives sign-in
five minutes before offering Retry or Stop. The origin alone also matches Azure's `/auth/login/` page and cannot prove
sign-in. `origin` ignores paths, query strings, and fragments; `url` requires an
exact URL. Conditions may also check visible/hidden controls, text, or values.

An existing authenticated session continues without a pause. Silent redirects
have a grace period (default 1500 ms) before the manual prompt appears. While
paused, the runner monitors the original application page even if login opens a
popup; subsequent steps remain on the verified application page. Completion in
a replacement tab requires a flow authored for that tab. Closing the application
page stops the run. Continue only requests another verification and cannot bypass
`until`. On timeout, Retry starts another verification window; Stop cancels the
run. Ordinary `ask-user` actions without `until` retain manual confirmation.

The planner can produce conditional browser prompts when the instruction or
current observation supplies completion evidence. If it cannot identify an
authenticated control, it keeps a manual prompt rather than guessing a selector.
Saved conditional plans replay without another LLM request.

## Runtime structure and extension

`src/runner.ts` coordinates execution, pauses, recovery, and evidence. Browser
operations are implemented by action adapters in `src/actions/`; the runner
contains no browser-action dispatch switch. `ask-user` remains a workflow action
owned by the runner because it controls input collection and manual completion.

Each action adapter binds a typed action to narrow dependencies, then exposes
`prepare()` and an executable operation. Preparation resolves inputs and checks
targets before dispatch. Optional `verify()` runs independently so retrying
verification after manual correction cannot repeat the action. Adapters return
outputs and messages; they cannot directly change run state. Retry-after-dispatch
and required-step-outcome policies live alongside each action implementation.

Selection uses a second interface in `src/controls/selection/`: a control can
prepare, select a value, and verify it. Saved `select` actions choose the native
select adapter; saved `select-combobox` actions choose the authored combobox
adapter with explicit option and verification locators. Native selection uses
option values, not labels. Adapter names appear in run events. There is no
heuristic fallback after partial interaction and no claim of support for every
ARIA or application-specific widget. Existing YAML formats remain valid.

To add a browser action, add its schema in `src/schema.ts`, implement its adapter,
and register it in `src/actions/registry.ts`. The typed registry requires coverage
of every browser action. Add behavior tests using a local browser fixture.
Planner generation is a separate capability: update `src/planner.ts` deliberately
if the planner should produce the new action. Authored actions can exist without
planner support.

To add a selection implementation, extend `SelectionSpec`, implement the selection
interface, and register it in `src/controls/selection/registry.ts`. Define how an
authored action selects that implementation; new configuration needs schema
validation. The runner requires no widget-specific changes.

Browser profiles, step-page selection, locators, conditions, sensitive controls,
and observation each have a module under `src/browser/`. `src/browser.ts` keeps
compatibility exports for existing callers. The condition algorithms, manual
pause lifecycle, table pagination policy, and existing composite-action retry
behavior are retained; further changes to those behaviors are separate work.
In particular, repeatable actions are not necessarily free of side effects:
combobox selection and paginated extraction can click controls.

Validate changes with `npm run typecheck`, `npm run build`, and `npm test`.
The tests require installed Chromium and permission to launch local browsers
and fixture servers.
