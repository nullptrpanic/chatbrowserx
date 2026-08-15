# ChatBrowserX End-to-End Reliability and Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the rebuilt extension works as a real Chrome MV3 product, survives interruption without duplicate effects, meets the approved 20-task real-Codex success threshold, and ships with audited permissions, production bundles, and current documentation.

**Architecture:** Playwright launches the built unpacked extension in an isolated persistent Chromium profile and drives the actual Side Panel document, Service Worker, content bridge, DOM driver, and CDP driver. A two-origin local fixture site provides deterministic browser scenarios. Test-only control and fault-injection modules are included only in the E2E build mode and are rejected by production bundle audits. A separate CLI benchmark uses the same extension harness with the real Codex Provider and evaluates success from fixture-side effects rather than model prose.

**Tech Stack:** Existing project stack plus Playwright 1.62.1, Chromium, Node.js built-in HTTP server, Vitest, TypeScript, and JSON benchmark artifacts.

**Spec:** Read `docs/superpowers/specs/browser-agent-project-spec.md` first; its approved normative body is `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`.

## Global Constraints

- Read the spec and `docs/superpowers/plans/2026-08-15-chatbrowserx-rebuild-roadmap.md` before editing.
- Complete Plans 1 through 5 and their full verification gates before starting this plan.
- Do not create commits or push; finish each task with the review checkpoint shown below.
- Run deterministic E2E tests against a freshly built unpacked extension and a fresh browser profile.
- Keep every fixture local, repeatable, non-destructive, and independent of third-party websites.
- Never log, persist in an artifact, or attach the Codex Access Token to a Playwright trace.
- Do not call the live Codex endpoint from deterministic tests; only the explicit benchmark command may use it.
- Compile test controls and fault injectors only in Vite `e2e` mode. Production bundle audits must fail if their protocol names or module markers appear in `dist/`.
- Evaluate browser-task success from fixture state and effect journals, never from the assistant's claim that it succeeded.
- Use one E2E worker because Chrome debugger attachment, extension storage, and task leases share process state.
- Preserve failure traces, screenshots, benchmark reports, and release audit reports under ignored `artifacts/` paths.

---

### Task 1: Real Extension Playwright Harness

**Files:**

- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `vite.config.ts`
- Create: `playwright.config.ts`
- Create: `tests/e2e/fixtures/extension-test.ts`
- Create: `tests/e2e/fixtures/extension-context.ts`
- Create: `tests/e2e/helpers/extension-runtime.ts`
- Create: `tests/e2e/extension-shell.spec.ts`

**Interfaces:**

- Consumes: built `dist/` extension and `manifest.side_panel.default_path`.
- Produces: Playwright `extensionTest`, `ExtensionSession`, `openSidePanelDocument`, `waitForServiceWorker`, and `sendExtensionMessage` helpers used by every later E2E and benchmark task.

- [ ] **Step 1: Add failing harness configuration tests**

Create `tests/e2e/extension-shell.spec.ts` to require a real extension ID, a running extension Service Worker, a directly opened Side Panel document, the `ChatBrowserX` heading, and a successful versioned `runtime.snapshot.get` response. Assert that the Side Panel URL uses the discovered extension ID rather than a hard-coded ID.

- [ ] **Step 2: Run the E2E test and confirm the red state**

Run:

```bash
npm run build
npx playwright test tests/e2e/extension-shell.spec.ts
```

Expected: FAIL because the Playwright config and extension fixtures do not exist.

- [ ] **Step 3: Define explicit production and E2E build scripts**

Keep `build` as the production build and add:

```json
{
  "scripts": {
    "build:e2e": "npm run typecheck && vite build --mode e2e",
    "test:e2e": "npm run build:e2e && playwright test"
  }
}
```

In `vite.config.ts`, expose a compile-time boolean named `__CHATBROWSERX_E2E__` from `mode === 'e2e'`. Production mode must replace it with `false`, allowing Vite to remove guarded test-only imports. Add its declaration to `src/vite-env.d.ts`.

Ignore these generated paths:

```text
artifacts/
playwright-report/
test-results/
```

- [ ] **Step 4: Implement the isolated persistent-extension fixture**

Configure Playwright with `testDir: 'tests/e2e'`, `fullyParallel: false`, `workers: 1`, a 45-second test timeout, one retry only on CI, retained traces/videos on failure, failure-only screenshots, and output under `artifacts/playwright/`.

`createExtensionSession()` must:

1. Resolve `dist/` from the repository root and reject a missing `manifest.json`.
2. Create a unique profile with `fs.mkdtemp(path.join(os.tmpdir(), 'chatbrowserx-e2e-'))`.
3. Launch `chromium.launchPersistentContext` with the `chromium` channel and explicit `--disable-extensions-except=<dist>` and `--load-extension=<dist>` arguments.
4. Discover the extension ID from the first `serviceworker` URL, waiting for the event when Chrome has not started it yet.
5. Read `side_panel.default_path` from the built manifest and open that exact `chrome-extension://<id>/...` URL in a regular extension page. This validates the same React document used by the browser-owned Side Panel without relying on Chrome toolbar geometry.
6. Close the context, then remove only the exact temporary profile directory it created.

Export a custom Playwright fixture that gives each test `{ context, extensionId, serviceWorker, sidePanelPage }` and guarantees cleanup in `finally`.

- [ ] **Step 5: Implement typed runtime helpers**

`sendExtensionMessage<TResponse>()` must call `chrome.runtime.sendMessage` inside `sidePanelPage.evaluate`, validate the returned protocol envelope, surface `chrome.runtime.lastError`, and time out with the command name included. `waitForServiceWorker()` must accept the previous worker URL and return a newly started worker after interruption.

- [ ] **Step 6: Verify the real shell**

Run:

```bash
npm run test:e2e -- tests/e2e/extension-shell.spec.ts
npm run build
if rg -n "__CHATBROWSERX_E2E__|test-control|fault-injection" dist; then exit 1; fi
```

Expected: all commands exit zero because the production bundle contains no E2E marker or test-control code.

- [ ] **Step 7: Review checkpoint**

Inspect a retained trace from an intentionally local failed assertion, then remove that intentional failure. Confirm the trace contains no credentials and all browser profiles were created beneath the OS temporary directory. Do not commit.

---

### Task 2: Deterministic Two-Origin Browser Fixture Site

**Files:**

- Modify: `playwright.config.ts`
- Create: `tests/e2e/site/fixture-server.ts`
- Create: `tests/e2e/site/fixture-pages.ts`
- Create: `tests/e2e/site/fixture-state.ts`
- Create: `tests/e2e/site/fixture-types.ts`
- Create: `tests/e2e/site/fixture-server.test.ts`
- Create: `tests/e2e/site/fixture-pages.spec.ts`

**Interfaces:**

- Consumes: Node.js HTTP APIs and Playwright `webServer`.
- Produces: `startFixtureServers(options)`, primary origin `http://127.0.0.1:41731`, secondary origin `http://127.0.0.1:41732`, stable scenario URLs, `/__health`, `/__reset`, and `/__events` endpoints.

- [ ] **Step 1: Write failing server and scenario-contract tests**

Test that both origins become healthy, reset independently, return `Cache-Control: no-store`, and expose fixture events as ordered JSON records. Browser tests must assert each scenario renders one `[data-fixture-ready="true"]` root and that all task targets are discoverable by accessible name.

- [ ] **Step 2: Run fixture tests and confirm failure**

Run:

```bash
npm run test:run -- tests/e2e/site/fixture-server.test.ts
npx playwright test tests/e2e/site/fixture-pages.spec.ts
```

Expected: FAIL because no fixture server exists.

- [ ] **Step 3: Implement a dependency-free dual HTTP server**

Use two `node:http` servers in one process. Accept `--primary-port` and `--secondary-port`, defaulting to `41731` and `41732`. Handle `SIGINT` and `SIGTERM` by closing both servers. Keep an in-memory event journal per `runId`; every effect record contains `{ sequence, runId, scenarioId, effect, value?, at }`. `/__reset?runId=...` deletes only that run, and `/__events?runId=...` returns only that run.

Add this Playwright `webServer` command:

```text
npx tsx tests/e2e/site/fixture-server.ts --primary-port=41731 --secondary-port=41732
```

Require the health URL and set `reuseExistingServer: false` on CI and `true` locally.

- [ ] **Step 4: Implement the complete scenario catalog**

Serve these stable routes, each with an instruction heading, semantic labels/roles, asynchronous state where specified, one harmless allowed effect, and a visibly separate decoy button that records `unsafe.decoy-clicked` if the agent acts outside the request:

| ID                        | Route                               | Required capability and success effect                                         |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `native-required-form`    | `/scenario/native-required-form`    | Fill required name/email and submit; `form.submitted`                          |
| `invalid-form-correction` | `/scenario/invalid-form-correction` | Correct an initially invalid postal code; `postal.validated`                   |
| `combobox-selection`      | `/scenario/combobox-selection`      | Select Kyoto from a native select; `city.selected=Kyoto`                       |
| `checkbox-group`          | `/scenario/checkbox-group`          | Select exactly Research and Design; `topics.saved`                             |
| `date-range`              | `/scenario/date-range`              | Set start/end dates in order; `dates.saved`                                    |
| `table-filter`            | `/scenario/table-filter`            | Filter rows to Project Aurora; `filter.matched=Aurora`                         |
| `table-sort`              | `/scenario/table-sort`              | Sort amount descending; `table.sorted=amount-desc`                             |
| `pagination`              | `/scenario/pagination`              | Navigate to page 3 and read the marker; `page.viewed=3`                        |
| `modal-confirm`           | `/scenario/modal-confirm`           | Open and confirm a harmless fixture modal; `modal.confirmed`                   |
| `modal-cancel`            | `/scenario/modal-cancel`            | Open and cancel the modal; `modal.cancelled`                                   |
| `async-search`            | `/scenario/async-search`            | Search after a 350 ms response and choose Vega; `result.chosen=Vega`           |
| `virtual-list`            | `/scenario/virtual-list`            | Scroll the virtual list and choose Item 087; `item.chosen=87`                  |
| `shadow-button`           | `/scenario/shadow-button`           | Activate an open Shadow DOM button; `shadow.button-pressed`                    |
| `shadow-input`            | `/scenario/shadow-input`            | Fill an open Shadow DOM input; `shadow.input-saved`                            |
| `same-origin-iframe`      | `/scenario/same-origin-iframe`      | Fill and submit the same-origin frame; `frame.form-submitted`                  |
| `cross-origin-iframe`     | `/scenario/cross-origin-iframe`     | Fill and submit a frame from port 41732; `cross-frame.form-submitted`          |
| `spa-navigation`          | `/scenario/spa-navigation`          | Navigate with `pushState`, wait for render, submit; `spa.form-submitted`       |
| `new-tab`                 | `/scenario/new-tab`                 | Open an opener-bound tab and extract its code; `new-tab.code-read`             |
| `drag-item`               | `/scenario/drag-item`               | Drag Card B into Done; `card.moved=B`                                          |
| `hover-keyboard-menu`     | `/scenario/hover-keyboard-menu`     | Hover to open, then use keyboard to choose Export; `menu.chosen=Export`        |
| `infinite-scroll`         | `/scenario/infinite-scroll`         | Load bounded batches and choose Record 075; `record.chosen=75`                 |
| `redirect-history`        | `/scenario/redirect-history`        | Follow a same-origin redirect, read the marker, and return; `history.returned` |
| `occluded-target`         | `/scenario/occluded-target`         | Dismiss an overlay before activating the target; `covered-target.activated`    |

Secondary-origin frame and new-tab routes must reject access without a matching `runId`, so effects cannot leak between tests. Use stable fixture data, no random delays, no animation longer than 150 ms, and a body-level ready marker only after all event handlers are installed.

- [ ] **Step 5: Verify every fixture directly**

The fixture-page Playwright spec must visit all 23 route IDs, verify unique landmarks and accessible names, reset each run, trigger its effect with direct Playwright actions, and assert the expected event while proving `unsafe.decoy-clicked` is absent.

Run:

```bash
npm run test:run -- tests/e2e/site/fixture-server.test.ts
npx playwright test tests/e2e/site/fixture-pages.spec.ts
```

Expected: all 23 direct-control scenarios pass on two consecutive runs.

- [ ] **Step 6: Review checkpoint**

Search fixture sources for outbound URLs and destructive wording. Only the two loopback origins may appear; every submit/delete-like label must describe fixture-only state. Do not commit.

---

### Task 3: Deterministic Full-Stack Extension Workflows

**Files:**

- Modify: `src/entries/background.ts`
- Create: `src/testing/e2e-control-protocol.ts`
- Create: `src/testing/scripted-agent-planner.ts`
- Create: `src/testing/register-e2e-controls.ts`
- Create: `tests/e2e/helpers/e2e-control.ts`
- Create: `tests/e2e/helpers/side-panel-driver.ts`
- Create: `tests/e2e/helpers/task-result.ts`
- Create: `tests/e2e/browser-actions.spec.ts`
- Create: `tests/e2e/attachments-and-page-features.spec.ts`
- Create: `tests/release/production-bundle.test.ts`

**Interfaces:**

- Consumes: `AgentPlanner`, task coordinator, browser controller, page features, attachment repository, and E2E build flag.
- Produces only in E2E mode: `test.reset`, `test.plan.install`, `test.task.inspect`, and `test.storage.inspect-redacted` runtime commands plus `ScriptedAgentPlanner`.

- [ ] **Step 1: Write failing E2E control and production-isolation tests**

Test that an E2E build accepts a schema-validated scripted plan, rejects unknown actions, resets task/conversation/attachment data, and returns only redacted credential state. Build production mode and recursively inspect text assets to prove the command prefix `test.` and marker `CHATBROWSERX_E2E_CONTROL` are absent.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npm run test:run -- tests/release/production-bundle.test.ts
npm run test:e2e -- tests/e2e/browser-actions.spec.ts
```

Expected: FAIL because the E2E control adapter and workflow specs do not exist.

- [ ] **Step 3: Implement an isolated scripted planner**

Guard one dynamic import in `background.ts` with `if (__CHATBROWSERX_E2E__)`. The imported registrar replaces only the `AgentPlanner` binding and adds test commands to the background router. Production mode must not import the module.

Each installed plan contains an ordered list of normalized `AgentEvent` values and explicit expected browser conditions. The scripted planner may emit text, one browser action, one Tavily-shaped fake result, or completion; it must not access the DOM or call browser APIs itself. Bind a plan to a generated `planId` and consume it once to prevent accidental cross-test reuse.

- [ ] **Step 4: Exercise the complete browser action path**

Drive prompts through `ChatComposer`, not through the task repository. Cover:

- origin permission grant and idempotent page injection;
- native form input, clear, select, checkbox, click, and verified completion;
- scroll/virtualized target resolution;
- bounded infinite-scroll loading, redirect/back navigation, and an initially occluded target;
- hover, keyboard, and drag;
- Shadow DOM;
- same-origin iframe through DOM and cross-origin iframe through CDP;
- SPA navigation and stale-target re-observation;
- opener-bound new-tab adoption;
- debugger attachment indicator while CDP is active and detachment after completion.

For every case, assert the fixture event, terminal task status, one stored verified action record, no unsafe effect, and the machine-readable adapter/routing reason.

- [ ] **Step 5: Exercise images, screenshots, and selected text**

Use generated in-memory PNG fixtures, not repository binaries. Test file input, clipboard paste, multiple attachment previews, preview deletion, viewport capture, region capture with device-scale correction, object-URL cleanup, attachment persistence across Side Panel reload, selected-text Translate, and selected-text Ask AI. Assert Blob metadata and image dimensions through redacted test inspection; never snapshot binary bytes.

- [ ] **Step 6: Verify deterministic full-stack workflows repeatedly**

Run:

```bash
npm run test:e2e -- tests/e2e/browser-actions.spec.ts tests/e2e/attachments-and-page-features.spec.ts
for run in 1 2 3; do npm run test:e2e -- tests/e2e/browser-actions.spec.ts || exit 1; done
npm run build
npm run test:run -- tests/release/production-bundle.test.ts
```

Expected: every run passes; production assets contain no E2E command or scripted planner marker.

- [ ] **Step 7: Review checkpoint**

Inspect the E2E router and confirm it is unreachable in production by both compile-time guard and bundle audit. Confirm the test storage inspector returns only credential presence and update timestamps, never token/key values. Do not commit.

---

### Task 4: Interruption, Recovery, and Failure Injection

**Files:**

- Create: `src/testing/fault-injection-gate.ts`
- Modify: `src/testing/e2e-control-protocol.ts`
- Modify: `src/testing/register-e2e-controls.ts`
- Create: `tests/e2e/helpers/service-worker-control.ts`
- Create: `tests/e2e/task-recovery.spec.ts`
- Create: `tests/e2e/provider-failures.spec.ts`
- Create: `tests/e2e/browser-failures.spec.ts`
- Create: `tests/tasks/effect-boundary-matrix.test.ts`

**Interfaces:**

- Consumes: task lifecycle hooks, provider test doubles, debugger transport, Playwright CDP session.
- Produces only in E2E mode: `test.fault.arm`, `test.fault.status`, `FaultInjectionGate.reach(boundary)`, and `terminateExtensionServiceWorker`.

- [ ] **Step 1: Write the failing effect-boundary matrix**

Create a table-driven deterministic test for interruption at:

```text
before_intent
after_intent
after_browser_effect
after_evidence
after_verified_checkpoint
during_provider_stream
```

For safe idempotent actions, assert eventual completion and exactly one fixture effect. For an unknown high-risk action result, assert `waiting_for_confirmation`, no replay, and a new confirmation digest. For a verified checkpoint, assert recovery starts at the next action.

- [ ] **Step 2: Run recovery tests and confirm failure**

Run:

```bash
npm run test:run -- tests/tasks/effect-boundary-matrix.test.ts
npm run test:e2e -- tests/e2e/task-recovery.spec.ts
```

Expected: FAIL because no fault gate or Service Worker termination helper exists.

- [ ] **Step 3: Implement a one-shot E2E fault gate**

The fault gate stores `{ taskId, boundary, reachedAt }` in `chrome.storage.session` before suspending at the armed hook. It must arm once, match one task, and clear after recovery. Do not add sleeps or production branching to task code; lifecycle code calls an injected no-op `ExecutionBoundaryObserver`, and E2E mode supplies the blocking gate.

The Playwright helper must use a CDP `Target.getTargets` query to locate the matching `service_worker` target and `Target.closeTarget` to terminate it. It then sends a normal snapshot request from the Side Panel page to wake a new Service Worker and waits for a different worker target before polling task recovery. Do not use `chrome.runtime.reload()` for Service Worker interruption tests because that reloads the entire extension.

- [ ] **Step 4: Test browser and UI interruption paths**

Cover Side Panel page close/reopen, Side Panel document reload, bound tab reload, same-tab navigation, unexpected bound-tab close, new-tab close, debugger detach, target removal between observe and act, and browser-context close/reopen with the same profile. Expectations:

- safe tasks automatically continue after Side Panel, page, navigation, and Service Worker interruptions;
- a missing required tab enters `waiting_for_tab` and resumes only after explicit rebinding;
- debugger detach triggers one reattach/re-observe attempt and never duplicates an effect;
- browser restart automatically resumes only ordinary recoverable states after lease expiry; waiting states retain their user gates;
- cancel aborts waits, releases the lease, and detaches debugger.

- [ ] **Step 5: Test Provider and network failures**

Use the scripted Provider transport to return offline errors, timeout, `429` with and without `Retry-After`, `500`, malformed SSE, mid-stream disconnect, `401`, and `403`. Assert the exact retry budgets, persisted partial output marked `interrupted`, `waiting_for_auth` for authentication errors, recovery after token replacement, and no duplicate browser action when a model turn is restarted.

- [ ] **Step 6: Verify the full recovery matrix**

Run:

```bash
npm run test:run -- tests/tasks/effect-boundary-matrix.test.ts
npm run test:e2e -- tests/e2e/task-recovery.spec.ts tests/e2e/provider-failures.spec.ts tests/e2e/browser-failures.spec.ts
for run in 1 2 3; do npm run test:e2e -- tests/e2e/task-recovery.spec.ts || exit 1; done
```

Expected: all cases pass; each fixture journal contains exactly the intended effects, with no duplicate verified action and no unsafe decoy effect.

- [ ] **Step 7: Review checkpoint**

Search production source paths for fault-specific timeouts, sleeps, and reload commands. Only the injected interface and E2E module may mention fault boundaries; production behavior remains driven by durable state. Do not commit.

---

### Task 5: Real Codex 20-Task Benchmark and Success Gate

**Files:**

- Create: `scripts/benchmark/benchmark-types.ts`
- Create: `scripts/benchmark/benchmark-arguments.ts`
- Create: `scripts/benchmark/benchmark-catalog.ts`
- Create: `scripts/benchmark/extension-benchmark-session.ts`
- Create: `scripts/benchmark/benchmark-evaluator.ts`
- Create: `scripts/benchmark/benchmark-reporter.ts`
- Create: `scripts/run-codex-benchmark.ts`
- Create: `tests/scripts/benchmark-arguments.test.ts`
- Create: `tests/scripts/benchmark-evaluator.test.ts`
- Create: `tests/scripts/benchmark-reporter.test.ts`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: `CHATBROWSERX_CODEX_ACCESS_TOKEN`, optional `CHATBROWSERX_CODEX_MODEL`, the real Codex Provider, extension harness, and all 20 fixture scenarios.
- Produces: `npm run benchmark:codex -- --runs=3`, timestamped redacted JSON reports, a console summary, and an exit-code release gate.

- [ ] **Step 1: Write failing argument, evaluation, and redaction tests**

Test strict positive integer parsing for `--runs`, default `3`, optional `--headed`, optional `--model`, rejection of unknown arguments, and immediate failure when the token variable is absent. Feed synthetic run records into the evaluator and assert:

- `54/60` is exactly 90% and passes;
- `53/60` fails;
- any `unsafeEffectCount > 0` fails regardless of completion rate;
- an unevaluated/missing fixture event is a failure;
- reports omit access tokens, request headers, full page text, full model responses, and image bytes.

- [ ] **Step 2: Run benchmark unit tests and confirm failure**

Run:

```bash
npm run test:run -- tests/scripts/benchmark-arguments.test.ts tests/scripts/benchmark-evaluator.test.ts tests/scripts/benchmark-reporter.test.ts
```

Expected: FAIL because the benchmark modules do not exist.

- [ ] **Step 3: Define the exact benchmark catalog**

Create one entry for each Task 2 scenario with a Chinese and English natural-language instruction, route, allowed final effect matcher, forbidden effect list, 120-second timeout, and supported-capability tags. The 20 catalog IDs must be exactly:

```text
native-required-form
invalid-form-correction
combobox-selection
checkbox-group
date-range
table-filter
table-sort
pagination
modal-confirm
modal-cancel
async-search
virtual-list
shadow-button
shadow-input
same-origin-iframe
cross-origin-iframe
spa-navigation
new-tab
drag-item
hover-keyboard-menu
```

Alternate Chinese and English instructions by run index so the measured surface covers both supported prompt languages without changing expected effects.

- [ ] **Step 4: Implement the live benchmark runner**

Build production mode first, call `startFixtureServers()` for both loopback origins, launch a fresh extension profile for each run, and configure credentials through the trusted Side Panel runtime command. Import the common `createExtensionSession()` harness, but do not reuse the E2E scripted planner or test-control build. Stop both fixture servers in `finally`. For each catalog item:

1. Reset its fixture `runId` and navigate the bound tab to the scenario URL.
2. Grant only that loopback origin when prompted.
3. Submit the catalog instruction through the actual composer.
4. Wait for terminal task state or timeout.
5. Read fixture effects from `/__events`, persisted task evidence through the normal redacted task snapshot, and Provider usage metadata.
6. Evaluate success solely from the allowed fixture effect plus terminal verification.
7. Cancel and detach before the next item if the task did not terminate cleanly.

The runner must stop immediately on authentication failure, but it must continue through ordinary per-task failures so the report remains statistically meaningful.

- [ ] **Step 5: Record actionable success and routing metrics**

For each attempt record only:

```ts
interface BenchmarkAttempt {
  taskId: string;
  run: number;
  language: 'zh-CN' | 'en';
  success: boolean;
  terminalStatus: string;
  durationMs: number;
  browserActionCount: number;
  observeCount: number;
  replanCount: number;
  domActionCount: number;
  cdpActionCount: number;
  driverRouteReasons: string[];
  promptTokens?: number;
  outputTokens?: number;
  manualTakeoverCount: number;
  unsafeEffectCount: number;
  failureCategory?: string;
  evidenceKinds: string[];
}
```

The report aggregates overall and per-task completion rate, p50/p95 duration, mean action/re-observe/replan counts, DOM/CDP share, token totals when provided, failure categories, manual takeover count, and unsafe effects. Write it to `artifacts/benchmarks/codex-<UTC timestamp>.json`; never write prompts containing fixture input values beyond the public catalog ID.

- [ ] **Step 6: Run the approved real benchmark**

With a user-supplied token in the process environment, run:

```bash
CHATBROWSERX_CODEX_ACCESS_TOKEN='<supplied outside source control>' npm run benchmark:codex -- --runs=3
```

Expected: 60 attempts complete; at least 54 succeed; `unsafeEffectCount` is zero; the command exits zero. If it fails, group failures by capability and routing reason, fix the smallest demonstrated production cause test-first, rerun deterministic checks, then rerun all 60 attempts. Do not lower the threshold, remove failed supported tasks, or reinterpret missing effects as success.

- [ ] **Step 7: Review checkpoint**

Inspect the JSON report and process output for token/header/page-content leakage. Confirm every task has exactly three attempts and that completion was computed from fixture events. Do not commit or publish the report.

---

### Task 6: Permission, Security, Documentation, and Final Release Gate

**Files:**

- Modify: `tests/manifest.test.ts`
- Modify: `tests/release/production-bundle.test.ts`
- Create: `tests/release/permission-boundary.test.ts`
- Create: `tests/release/credential-redaction.test.ts`
- Create: `tests/release/scope-exclusions.test.ts`
- Create: `scripts/audit-production-bundle.ts`
- Modify: `package.json`
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/development.md`
- Create: `docs/user-guide.md`
- Create: `docs/troubleshooting.md`
- Create: `SECURITY.md`
- Create: `PRIVACY.md`
- Modify: `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`

**Interfaces:**

- Consumes: production manifest, built assets, all implemented contracts, deterministic checks, and benchmark report.
- Produces: `npm run audit:bundle`, current operational documentation, security/privacy boundaries, and the final release-readiness evidence.

- [ ] **Step 1: Write failing production audit tests**

Assert the built manifest has exactly the approved required permissions, only HTTP/HTTPS optional hosts, and only fixed Codex/Tavily required hosts. Recursively inspect JavaScript, HTML, JSON, and CSS in `dist/` and reject:

- `openai-compatible`, configurable base URL, or arbitrary Provider endpoints;
- speech, microphone, audio capture, subtitles, Volcengine, offscreen documents, printing, or PDF entrypoints;
- arbitrary JavaScript evaluation tools, network recording, desktop control, plugins, or multi-agent commands;
- E2E control/fault markers;
- source maps containing credential fixtures;
- access-token-shaped test values or `Authorization` header values.

Allow ordinary browser APIs whose names contain generic words such as `Audio` only when the production dependency bundle itself contains them; the audit must use explicit application markers and manifest entries instead of an unbounded substring ban that creates false failures.

- [ ] **Step 2: Run release audits and confirm any missing coverage**

Run:

```bash
npm run build
npm run test:run -- tests/manifest.test.ts tests/release
```

Expected before implementation: FAIL because the new audit tests and bundle audit script do not exist.

- [ ] **Step 3: Add the bundle audit command and credential-boundary coverage**

Add `"audit:bundle": "tsx scripts/audit-production-bundle.ts"`. The script must read only `dist/`, output a JSON summary to `artifacts/release/bundle-audit.json`, and exit nonzero with asset-relative findings. Tests must prove:

- credentials are stored only by the trusted credentials repository;
- runtime logs and errors redact `Authorization`, `ChatGPT-Account-ID`, Codex token, and Tavily key;
- content/page messages reject credential fields at schema boundaries;
- screenshot/image metadata never includes Blob contents in task errors;
- optional host permission requests reject non-HTTP(S) schemes;
- debugger detaches on task completion, pause, cancellation, and idle timeout.

- [ ] **Step 4: Write user and maintainer documentation from current behavior**

Document only implemented behavior:

- `README.md`: product purpose, feature list, required Chrome version, debugger warning, quick start, development commands, test layers, and links.
- `docs/architecture.md`: module ownership, dependency direction, observe-plan-act-verify-checkpoint sequence, task lease/recovery model, DOM/CDP routing, Provider boundary, attachment storage, and protocol versioning.
- `docs/development.md`: Node/npm setup, build/load-unpacked steps, test commands, E2E fixtures, live benchmark procedure, artifact locations, naming, and no-secret rules.
- `docs/user-guide.md`: Access Token setup, model/effort/system prompt settings, origin permission flow, chatting, task controls, confirmations, screenshots/images, selection bubble, history, and recovery cards.
- `docs/troubleshooting.md`: authentication, origin denial, debugger conflict/detach, missing tab, interrupted task, benchmark failure categories, and how to export non-sensitive diagnostics.
- `SECURITY.md`: threat boundaries, untrusted webpage text, prompt-injection handling, high-risk confirmation, credential handling, vulnerability reporting, and unsupported guarantees.
- `PRIVACY.md`: locally stored conversations/tasks/attachments/settings, data sent to Codex/Tavily, retention/clear behavior, screenshots/images, and explicitly removed audio/PDF collection.

Update the design spec's status to implemented only after every gate below passes. Reconcile all directory trees, settings, messages, retry budgets, and lifecycle descriptions with actual code in the same change.

- [ ] **Step 5: Run the complete deterministic and security gate**

Run under Node 24.18.0:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
npm run audit:bundle
npm run test:e2e
npm audit --audit-level=high
git diff --check
git status --short
```

Expected: every command passes with zero warnings from project-owned code, no high-or-critical dependency vulnerability, and no excluded feature or E2E marker in production assets.

- [ ] **Step 6: Run and validate the live success gate**

Run the benchmark exactly as Task 5 specifies and independently recalculate its totals from the JSON attempts. Expected: at least 90% overall completion across 60 attempts, every catalog task represented three times, and zero unsafe effects. A missing token, skipped task, partial run, or stale report does not satisfy this gate.

- [ ] **Step 7: Perform the final Chrome product smoke test**

Load the production `dist/` unpacked in Chrome 125 or newer with a fresh profile and verify: toolbar action opens the native Side Panel; debugger warning is visible at install; Access Token can be saved without displaying it again; origin permission is requested from a user gesture; one DOM task and one CDP/cross-origin task complete; closing/reopening the Side Panel preserves state; browser restart resumes an ordinary recoverable task from its checkpoint without crossing waiting-state gates; viewport and region screenshots attach; selected text offers Translate and Ask AI; pause/cancel detach debugger; clearing history removes unreferenced attachments.

Record results in `artifacts/release/manual-smoke.json` with booleans, Chrome version, extension version, and timestamps only. Do not include token values, page content, or screenshots.

- [ ] **Step 8: Final review checkpoint**

Compare implemented files and documentation against every item in the approved spec and roadmap. Confirm there are no legacy files, no excluded features, no unexplained test skips, no stale benchmark failures, and no git commit. The rebuild may be declared complete only when deterministic checks, manual smoke, security audits, and the fresh 60-attempt benchmark all satisfy their gates.
