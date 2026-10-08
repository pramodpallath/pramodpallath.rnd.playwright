# pramodpallath.rnd.playwright

In Flow Studio, write `Set username to {UserName}` in a step and save it.
The Execution panel creates a `UserName` input field automatically. Enter its
value there before clicking **Run flow** or **Repair & run**. Required inputs
are checked before starting. Names are case-sensitive. Values are not saved in
YAML; passwords, OTPs and PINs must be entered directly in the browser.

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
explanation. Passwords and other sensitive fields still require manual entry.

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
