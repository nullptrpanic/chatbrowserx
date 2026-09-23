# Verification turnaround optimization — 2026-09-22

## Scope and design

The user authorized faster development verification, including parallelism and removal of genuine
duplication. They explicitly paused the Feishu history task if the page itself is unavailable. This
change touches only test scheduling, existing case tags, package commands and verification docs;
it does not alter translation or Agent product behavior. No commit or push is requested.

Baseline: frozen `task-failure-repair-20260922-luJTsq`, 290/290 browser cases with one worker,
9.4 minutes. Candidate: `.runtime/validation-speed-20260922-I1vB3I`. The candidate retains the same
production source while validating the scheduling change. Its separately rebuilt modules have the
same bytes; only the background module filename and its loader import name changed. The workspace's
development `dist` was not rebuilt or replaced.

The earlier [V20 timing audit](translation-renderer-contracts-validation-20260921.md#v20-execution-cost-diagnosis)
records 21 broad browser executions with at least 200 passing cases, totaling 185.5 summed execution
minutes. This is not exclusive wall-clock time or 21 successful gates. The main avoidable cost was
repeating broad regression/site matrices during each repair iteration. The quick lane addresses
that repetition; parallel scheduling shortens the final full gate. This is not a model-latency change.

The bounded execution plan is:

1. Read existing timing evidence and independently audit typical cases/duplication.
2. Verify a representative quick lane and safe project partition with RED/GREEN discovery tests.
3. Trial the eight typical cases twice with two independent headless workers; retain any failure.
4. Run the normal quick command once, then the unchanged complete case set once on two workers
   after serial foreground checks. Do not overlap timed runs with other heavy checks.
5. Preserve the full regression archive, run repository gates, inspect results, and record actual
   time rather than a speculative percentage.

## Changes and coverage trade-offs

- **Two execution lanes:** one-worker foreground tests first; then two-worker headless translation
  tests. Fresh per-test processes/profiles remain unchanged. No live authenticated Profile is copied
  or shared, and no retries/timeouts/assertions are relaxed.
- **Eight tagged typical cases:** use existing assertions, not duplicate smoke implementations.
  They cover layout/icons, table/editor structure, scrolling/sticky reuse, provider-error refresh,
  changing versus stable text, native video/no-image-capture, partial output/cache and context
  without private drafts. Full runs still include every case once.
- **Explicit build reuse:** `test:e2e:built` is for the already-frozen build. Normal quick/full
  commands still build by default, so normal verification does not silently test stale product code.
- **No deletion without equivalence:** the audit found that similar media/CSS/clip/editor cases
  exercise distinct semantics. Existing negative time windows also detect late requests and
  automatic retries. They are retained; only the day-to-day fast lane is reduced to typical cases.
  Deleting these regressions for a small additional gain is not justified by the available evidence.

## Evidence

All command logs are under `.runtime/validation-speed-20260922-I1vB3I/`.

| Check                                                           | Result                                                                                                     | Log                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- |
| Real Playwright discovery regressions before config change      | RED: no project partition and no quick project                                                             | `scheduling-red.log`        |
| Discovery after config/tags                                     | 2/2 pass: every case maps once; quick lane selects exactly eight contracts                                 | `scheduling-confirmed.log`  |
| Final discovery test, including effective parallel-worker guard | 2/2 pass; 2.48 s                                                                                           | `scheduling-final.log`      |
| Two-worker quick lane repeated twice, zero retries              | 16/16 pass; Playwright 25.7 s, command 26.30 s                                                             | `quick-parallel.log`        |
| Normal `test:e2e:quick`, including typecheck/build              | 8/8 pass; Playwright 12.8 s, whole command 21.05 s                                                         | `quick-command.log`         |
| Complete `test:e2e:built`, same 290 cases, zero retries         | 290/290 pass; Playwright 5.8 min, whole command 347.95 s                                                   | `browser.log`               |
| Full units                                                      | 1,764/1,764 pass, 143 files; 57.15 s                                                                       | `units.log`                 |
| Format and lint                                                 | Pass, zero lint warnings                                                                                   | `format.log`, `lint.log`    |
| Production bundle / sandbox checks                              | Pass: 17 built assets; sandbox integration valid                                                           | `bundle.log`, `sandbox.log` |
| Sample catalog                                                  | 39 valid sample definitions; not 39 live passes                                                            | `catalog.log`               |
| Source, build-content and executed-case integrity               | Same 199 source files; same 290 executed cases; no test-body changes after excluding smoke tags/formatting | `integrity-final.log`       |

Commands were run in the frozen candidate for build/browser/unit/bundle checks, and in the
workspace for format/lint/sandbox/catalog checks. The final targeted discovery test was run again
in the workspace after adding the worker-count guard. The earlier full unit run and the final
targeted rerun both passed; no product source or browser assertion changed between them.

Compared with the earlier 9.4-minute one-worker browser run, the complete browser gate is about
38% shorter. The eight-case lane is approximately 21 seconds including build on this machine.
The full unit duration is not a before/after comparison: independent format/lint checks ran
alongside it, whereas timed browser runs had no competing browser/build/full-unit jobs.

Frozen identities (SHA-256 of the sorted relative-path/content-hash manifest):

- Production source: `0cd1478c8804d681e55eba362079b06f19b906ae55ed8b08e2858175052e9cec`.
- Candidate build: `347532bbdfee6517ae46e07484d673b2d2c0b5ad3d47304fa1352ad97ced5815`.

The intermediate discovery test assumed JSON reporter output included project worker/use options.
It does not; that harness-test failure is retained in `scheduling-green.log`. The corrected test
uses actual config for those options and actual Playwright discovery for case routing. Quick-trial
Node color warnings are from the existing `NO_COLOR`/`FORCE_COLOR` environment conflict, also
present in the baseline log; subsequent measurements remove `NO_COLOR` for that invocation only.
The initial log-integrity check matched second durations but omitted three millisecond-duration
cases (`integrity.log`). Correcting the parser confirmed both complete 290-case sets are identical
(`integrity-final.log`); no browser case was removed or rerun to alter the result.

The independent final review found no material scheduling/isolation/coverage blocker. Its useful
follow-up was to assert effective parallelism explicitly, now covered by the final discovery test.

The old 9.4-minute run and new full run are one observation each, not a many-run speed distribution.
The goal is to eliminate repeated full-suite work during iteration and safely shorten the final
gate, not to claim a universal development-time SLA. Authenticated live samples still require
their canonical runner and independent profiles; this harness-only change does not requalify or
claim a pass for the paused Feishu chat task.
