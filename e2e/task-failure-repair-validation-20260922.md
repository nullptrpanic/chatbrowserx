# Browser task failure repair — 2026-09-22

## Outcome and scope

**Network evidence is repaired and its original live sample passes. Month-history reading is still unresolved.** This report does not declare both tasks complete.

The [execution plan](task-failure-repair-plan-20260922.md) uses the existing browser-tool architecture and canonical runner. There is no translation renderer change, site-specific selector, alternate authentication path, new dependency, subagent, commit or push in this repair.

Candidate: `.runtime/task-failure-repair-20260922-luJTsq`, product revision `d503bbb9-v20-task-repair-1`, based on frozen `d503bbb9-v20`. Only these production files change:

- `src/tools/browser/availability.ts`: expose the complete network workflow from the first turn instead of adding readers in later turns. Current-run capture tab binding remains.
- `src/tools/browser/contract.ts`: describe execution prerequisites rather than claiming tools will appear later.
- `src/browser/network/network-capture-registry.ts`: keep feedback consistent and enforce that `get` can read only IDs returned by `list` in the current frozen capture. A fresh capture starts with no listed IDs. Active-capture, tab, release and debugger-loss boundaries remain enforced.

The extra registry check is necessary because earlier catalog gating partly supplied the list-before-get restriction. Merely exposing all tools would leave that prerequisite unenforced. No broad tool-disclosure rewrite is needed.

## Preserved failures and original-sample replay

| Task                          | Previous failure                                                                                                                                                                                       | Candidate evidence                                                             | Current result                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safe network-request evidence | After start/reload/wait, the model incorrectly reported missing stop/list/get capabilities. Later Provider requests already contained stop, so this was not a missing executor or failed HTTP request. | `samples/browser-network-evidence/benchmark/20260922T120200.239Z/01.json`      | Pass: start, reload, stop, list and get each run once. Safe GET evidence has host `leetcode.com` and status 200; final text confirms no code execution/submission. Seven Provider requests, zero retries; all four network tools are disclosed throughout. |
| Specified-month chat history  | Actual chat content remained loading; one previous scroll targeted a clipped sidebar preview rather than the history.                                                                                  | `samples/lark-messenger-august-history/benchmark/20260922T120349.208Z/01.json` | Fail: target group confirmed, but no readable August history or verified boundary. A search also attempted submitted typing, violating the frozen policy and returning a state mismatch. No successful history scroll.                                     |

The old failed reports remain at `samples/browser-network-evidence/benchmark/20260922T112920.491Z/01.json` and `samples/lark-messenger-august-history/benchmark/20260922T112619.592Z/01.json`. No sample contract, expected result or failed report was weakened/replaced.

After the browser gate, the two predeclared additional serial network replays also pass: `samples/browser-network-evidence/benchmark/20260922T121655.979Z/01.json` and `02.json`. Each has seven Provider requests, zero retries, each required tool exactly once, and request/response body flags explicitly false. Including the original replay, the candidate is **3/3** on this unchanged sample. This is not a broad reliability estimate or a controlled speed comparison.

## Why chat is not reported as repaired

Bounded direct-UI probes used the canonical dedicated Profile and the original V20 extension, without a model task, private application-state reads or a separate message API. The actual DOM message region stayed at `Loading...` after waiting and a normal reload. There was no message-history scroller to inspect. The visible scrollable sidebar is not a substitute for the missing history.

Page errors from Feishu CDN scripts reported unregistered `passport::getCurrentAuthInfo` and `navigation::getNavigationInfo`, plus a null `getBoundingClientRect` access. This is evidence of a target-page/runtime initialization problem; it does not establish a precise authentication or Feishu implementation root cause. Standalone verification checks the logged-in shell, not that a particular conversation's messages have loaded.

The original candidate replay confirms the blocker. It has six failed acceptance checks: submitted typing/read-only scope, missing `browser_scroll`, no-submitted-typing, submitted-state readback, missing coverage-boundary text, and truthful blocker text. The search submission failure is recorded separately; it is not excused by the page-loading failure. The report does not claim any message was sent.

No production observer change can recover message content that the page has not rendered. Rewriting Feishu internals, copying authentication, using another API as browser-test evidence, or inventing a boundary would not meet the task. The next meaningful full-history verification requires a normally loaded message panel in this canonical environment. Until then this task remains failed.

## Verification

Logs below are relative to `.runtime/task-failure-repair-20260922-luJTsq/`. Build/unit/browser commands use the isolated candidate; formatting/lint and sandbox commands use the root checkout as noted. The user's root `dist` was not rebuilt.

| Check                                                               | Result                                                           | Evidence                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| New catalog and list-before-get regressions, before production edit | Both fail for the intended reason, then pass after the repair    | RED tool output and plan ledger |
| Focused availability, registry, executor and tool-schema tests      | 267 / 267 pass                                                   | `focused.log`                   |
| `npm run build` in candidate                                        | Pass, including TypeScript                                       | `network-candidate-build.log`   |
| `npm run test:run -- --maxWorkers=2` in candidate                   | 1,762 / 1,762 tests, 142 files, 29.45 seconds                    | `units-confirmed.log`           |
| `npm run test:e2e` in candidate                                     | 290 / 290 pass, 9.4 minutes                                      | `browser.log`                   |
| Root `npm run format:check`                                         | Pass, including final documentation                              | `format.log`, final tool output |
| Root `npm run lint`                                                 | Pass                                                             | `lint.log`                      |
| Bundle audit                                                        | Pass, 17 assets                                                  | `bundle.log`                    |
| Root `npm run check:sandbox`                                        | Pass                                                             | `sandbox-root-confirmed.log`    |
| Catalog validation                                                  | 39 valid samples, not 39 live passes                             | `catalog.log`                   |
| Focused self-review and source/build integrity                      | Pass for the changed network lifecycle; chat limitation retained | Plan ledger, final tool output  |

The focused command is `./node_modules/.bin/vitest run tests/tools/browser/availability.test.ts tests/browser/network/network-capture-registry.test.ts tests/browser/browser-tool-executor.test.ts tests/agent/tools/browser-tool-schema.test.ts`. Bundle/catalog commands are `npm run audit:bundle` in the candidate and root `npm run e2e:catalog:validate`.

Live runs invoke the canonical `./node_modules/.bin/tsx e2e/runner/benchmark.ts <sample-id> [runs]` directly after the isolated build, with `CHATBROWSERX_LIVE_EXTENSION_PATH` pointing to the candidate's `dist` and `CHATBROWSERX_LIVE_PRODUCT_REVISION=d503bbb9-v20-task-repair-1`. This avoids the npm live wrapper rebuilding the user's root `dist`. Standalone verification and supported settings seeding were completed before execution. The original samples each use one run; the later network batch uses two.

Final integrity checks verify all 216 original V20 source/build hashes unchanged and all 199 production source entries matching between candidate and root. The SHA-256 of the sorted candidate `src/` + `dist/` file-hash manifest (216 files) is `13a0ed1b0dda51f04a7588e73432e6a42ae57a091509078d09859d0b206b33bb`. The focused self-review checked lifecycle messages, first-turn disclosure, active-capture rejection, per-page listed-ID admission, fresh-capture reset and resumed-run tab binding.

Retained validation failures:

- `units.log`: four first-turn catalog expectations needed updating to the intended stable catalog; two framework-layout failures were caused by missing docs/example files in the old isolated snapshot. Those tests were not removed or weakened. Corrected tests and complete packaging produce the full passing rerun.
- `sandbox.log`: the old isolated snapshot lacks `sandbox/Cargo.toml`. Root sandbox verification uses the existing canonical configuration and passes; no secret config was copied into the candidate.

## Development turnaround, not model latency

The user meant our translation development-and-verification cycle taking hours. The earlier five general Agent task timings are not a measurement of that cycle.

The retained [translation validation record](translation-renderer-contracts-validation-20260921.md#v20-execution-cost-diagnosis) records 21 broad browser executions with at least 200 passing cases, totalling **185.5 summed execution minutes**. This includes failed executions' passing cases; it is neither 21 successful gates nor exclusive wall-clock time. A single full browser gate takes roughly 8–11 minutes. Repeating broad gates and site matrices before resolving focused/visual defects accounts for substantial avoidable rework.

The execution policy for this repair is: reproduce the actual failed sample, add the smallest generic regression, make the local repair, replay the same sample, freeze the candidate, then run the broad gates once. Live browser jobs are serial; gates do not overlap another live browser. No repeated whole-site matrix was started for this network-only change. This is a workflow correction, not a measured percentage speedup or a promise that every task will finish within a fixed time.

Changes remain uncommitted. The inherited translation work and V20 evidence are preserved. Passing the network case and repository gates does not close the failed chat case or guarantee future remote-page/model behavior.
