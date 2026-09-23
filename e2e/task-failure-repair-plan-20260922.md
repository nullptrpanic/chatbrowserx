# Browser task failure repair plan — 2026-09-22

> Execution: inline, using systematic debugging, test-driven development and verification-before-completion. The user requested implementation without another approval checkpoint. No subagents, commit or push.

**Goal:** Close the two retained failed read-only tasks: complete date-bounded chat history and safe network-request evidence. Reduce development turnaround by validating the demonstrated failure before broad gates.

**Architecture:** Keep the existing structured browser tools, durable checkpoints, executor validation and canonical E2E runner. Repair demonstrated generic observation/tool-discovery defects in their current owners. Do not add domain-specific selectors, OCR, authentication shortcuts, automatic task retries or a new renderer.

**Tech stack:** TypeScript, Chrome extension/CDP, Vitest, Playwright, the existing Codex Provider.

**Spec:** The unchanged contracts in `samples/lark-messenger-august-history/sample.json` (v1) and `samples/browser-network-evidence/sample.json` (v3), plus `EVALUATION_STANDARD.md` and `RUNBOOK.md`.

## Constraints and review focus

- Preserve the inherited translation changes, frozen V20 evidence, user's root `dist` and development process. Build a separate candidate below `e2e/.runtime`.
- Keep remote operations read-only. Never submit messages/code or record credentials/raw traffic.
- A completed task is not a pass unless independent contract checks pass. Never weaken the two frozen contracts or replace failed reports.
- Check real message-history containers versus clipped sidebar previews; a tiny preview's verified boundary is not proof of whole-history coverage.
- Distinguish an actually loading page from missing/truncated observations; do not fabricate messages or arbitrarily increase every timeout.
- Network tools must be discoverable while invalid lifecycle operations, wrong tabs, unlisted IDs and stale snapshots remain executor-rejected.
- After each correction, run focused regressions and the actual failing sample first. Freeze the final candidate before the broad required gates. Preserve and classify every failure.

## 1. Preserve and diagnose the failures

- [x] Read both frozen contracts, failed benchmark reports, execution sequence and Provider tool-disclosure evidence.
- [x] Verify network lifecycle enforcement and whether a stable tool catalog can remove the demonstrated first-turn discovery trap without relaxing execution permissions.
- [x] Inspect the target chat with the canonical authenticated environment; compare visible DOM/AX content and advertised scroll containers, without accessing private application state or a separate API.
- [x] Record the root cause and concrete failing regression before modifying each production owner. The chat probe found an unavailable page runtime, not a reproducible observer omission, so no speculative observer patch was made.

Files: `src/tools/browser/availability.ts`, `src/tools/browser/contract.ts`, `src/browser/network/network-capture-registry.ts`, `src/browser/observation/page-observer.ts`, the relevant structured DOM/scroll readers discovered by the trace, and their existing tests.

## 2. Repair network tool discovery

- [x] Add a deterministic first-turn/start/reload/stop/list lifecycle regression to `tests/tools/browser/availability.test.ts`; the available catalog must not falsely imply absent network capabilities.
- [x] Run that regression against the current implementation and retain RED output.
- [x] Make the smallest catalog/contract change justified by the trace, keeping tab/generation/listed-ID enforcement in the executor.
- [x] Run availability, tool-contract and network-registry regressions; cover idle calls, failed start, other-tab operations and resumed runs.
- [x] Verify and rerun the unchanged `browser-network-evidence` sample through the canonical runner on the isolated candidate; all five required tools and safe GET readback must pass.

## 3. Repair message-history observation/readiness

- [x] Establish whether the missing history is page loading, observation exclusion, target misclassification or a combination, using bounded probes rather than a whole task batch.
- [ ] **Blocked:** add a synthetic regression and correct an observation owner only if real message content exists but the observer omits it. Actual DOM still contains `Loading...`, so that condition has not been demonstrated.
- [x] Verify and rerun the unchanged `lark-messenger-august-history` sample; preserve the failed report. The group is confirmed, but actual August facts and the required coverage boundary remain unavailable. The task is **not fixed**.

## 4. Final verification and handoff

- [x] Run both original samples with their unchanged declared count of one on the frozen candidate; do not cherry-pick attempts or change settings.
- [x] After the full browser gate, run two additional serial network attempts on the same candidate. Both pass; all attempts are retained, with no automatic retries or performance-speedup claim. Do not rerun chat merely to wait out the same unavailable page.
- [x] Run formatting, lint, full unit/browser gates, bundle audit, sandbox check and catalog validation under the repository's isolated-build convention.
- [x] Review the final focused diff for safety, lifecycle consistency and regressions; no new external agent.
- [x] Record exact commands, attempts, failures, scope limits and wall-clock checkpoints in the [validation report](task-failure-repair-validation-20260922.md). Explain what changed and why. Leave changes uncommitted.

## Execution ledger

- Intake: both additional failures are in scope after the user's explicit implementation request. Generic Agent latency data does not explain the translation-development turnaround.
- Initial evidence: network start succeeds and announces stop; later Provider requests contain stop, yet the model claims it is missing. Month-history output reports persistent `Loading...`; one scroll actually targets a 197×20 sidebar preview, so its target-local boundary cannot prove message-history completeness.
- Ruling: plan and evidence live under `e2e/` per project instructions. Inline execution, existing dirty checkout and no commits/subagents supersede skill workflow defaults; preserve all inherited changes.
- Pre-flight: the tasks share the browser tool contract but not a proposed new API. Do not globally stabilize or rewrite unrelated tool definitions.
- Network RED: first-turn catalog lacks stop/list/get. A second RED proves get previously accepted an undisclosed ID; stable discoverability therefore also requires list-before-get validation in the existing registry. Both regressions fail for their intended reasons and pass after the correction. Availability, registry and browser executor: 137/137 pass (1.19 seconds).
- Chat probe: the original V20 build, canonical Profile and direct UI click (without a submitted model task) reproduce `Loading...` in the actual DOM. After 27 seconds and a separate reload probe, no message-history scroller exists. Page errors originate in Feishu CDN scripts: `passport::getCurrentAuthInfo` / `navigation::getNavigationInfo` unregistered, and `getBoundingClientRect` on null. This establishes a page-runtime blocker, not missing message DOM in the product observer. Shell-only standalone verification passes and does not establish chat readiness.
- Ruling: do not patch Feishu internals, invent content or weaken history coverage. Investigate only normal UI recovery; if it cannot load, report the external blocker separately while completing the supported network repair.
- Candidate: `.runtime/task-failure-repair-20260922-luJTsq`, revision `d503bbb9-v20-task-repair-1`. Only three production files differ from frozen V20; root `dist` is untouched.
- Network original replay: `samples/browser-network-evidence/benchmark/20260922T120200.239Z/01.json` passes. All five required tools execute once; GET / leetcode.com / 200 evidence is returned, with no code execution/submission. All seven Provider requests expose all four network tools. This is correctness evidence, not a latency comparison.
- Chat original replay: `samples/lark-messenger-august-history/benchmark/20260922T120349.208Z/01.json` fails. In addition to persistent message loading, one attempted search uses submitted typing and fails the frozen read-only policy; it also returns `ACTION_STATE_MISMATCH`. No real history scroll or coverage boundary is obtained. Do not attribute every failed check solely to page loading.
- Narrow regressions: 267/267 pass. Full isolated units: 1,762/1,762 pass after correcting stale catalog assertions and incomplete snapshot packaging. Formatting, lint, bundle audit, root sandbox integration and the 39-sample catalog pass. Final browser gate: 290/290 pass in 9.4 minutes; original failed check logs remain available.
- Reproducibility: network batch `20260922T121655.979Z` passes 2/2 with seven Provider requests, zero retries and the complete required tool sequence in each attempt. Together with the original replay: 3/3 candidate passes. Both additional get calls explicitly leave request/response body flags false.
- Self-review: only three production owners change; stable disclosure does not bypass active-capture, listed-ID or current-tab checks. No new abstraction is needed. All 216 original V20 source/build hashes remain unchanged and 199 candidate source hashes match root. The final source/build fingerprint is recorded in the validation report.
- Handoff: the network repair and repository verification are complete; month-history reading remains failed due to the unavailable message panel, with the search-submission policy violation also retained. Overall two-task completion is not claimed.
