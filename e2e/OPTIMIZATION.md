# Browser Agent Optimization Ledger

This file records optimization decisions and measured outcomes. It does not redefine environment,
sample, result, or evaluation contracts; those remain owned by `RUNBOOK.md`, `SAMPLE_SPEC.md`, and
`EVALUATION_STANDARD.md`.

## Admission Rule

The original product baseline for this program is commit `59f6906`. Later architecture work uses
the explicitly frozen revision recorded in its decision entry. Each candidate changes one behavior
and is evaluated independently against its declared baseline or the latest admitted candidate.

A candidate is admitted only when:

- evidence integrity is valid on both sides;
- every critical sample preserves the baseline success rate;
- no new unexplained fallback, stale reference, mismatch, loop, or ambiguous mutation appears;
- it produces either a reproducible correctness improvement or a material resource improvement;
- provider variation is separated from product effects with interleaved runs when needed.

Correctness is the hard gate. Lower Token use, fewer calls, or lower latency never compensates for a
success-rate regression. Failed and rejected attempts remain immutable evidence.

For repeated critical batches, candidate mean and P95 total Tokens, task/model elapsed time,
first-event latency, and first-text latency must each remain within 5% of the interleaved baseline.
Mean model rounds and Tool Calls must not increase; one P95 round or call is treated as inconclusive,
not as a gain. Deterministic tool-definition size and schema variants must not regress. Admission
also requires one attributable benefit: a reproduced defect is fixed, total Tokens or elapsed time
improves by at least 8%, or tool-definition size improves by at least 15%. Provider or site variance
inside these margins is reported as inconclusive.

Statuses are `admitted`, `rejected`, `measuring`, and `queued`. `implemented` alone is not a status
because unmeasured code is not an accepted optimization.

## Current Capability Reference

On 2026-11-13 the user requested a new performance reference for the framework Agent/Provider
architecture: retain native conversation and tool evidence until compaction, preserve interrupted
input, and enable Provider-hosted search. The earlier truncated-history/tool-set baseline is retained
as migration-cost evidence; resource gates apply between equivalent capability sets under
`EVALUATION_STANDARD.md`.

The local frozen reference is `081eb45a627d64439b5b0836e4c5416bd638cb28-dirty-20f7e92a6a7fa7bf`,
recorded under `e2e/.runtime/agent-final-sampling/frozen-baseline/`. Status remains **measuring**:
the final network sample passed 1/2, editor replacement 2/2, and public documentation reading 2/2.
The network failure is a one-character request-ID transcription error; it is not waived by the new
resource reference. No full-matrix or general success-rate claim is made.

## Critical Baseline Set

Use the frozen sample contracts already stored outside Git under `e2e/samples/`:

| Behavior                    | Minimum admission evidence                                             |
| --------------------------- | ---------------------------------------------------------------------- |
| Named document section      | 5 baseline and 5 candidate attempts                                    |
| Full document analysis      | 5 baseline and 5 candidate attempts                                    |
| Messenger history by month  | 1 baseline and 1 candidate attempt                                     |
| LeetCode editor replacement | 1 baseline and 1 candidate attempt with mutation authorization         |
| Exam page interaction       | 1 baseline and 1 candidate attempt                                     |
| Browser network evidence    | Required for candidates that affect network-tool discovery             |
| Sandbox Skill selection     | Required for candidates that affect Skill disclosure or Sandbox output |

Run the narrow affected sample first. Stop and classify its first material failure before running a
larger batch. Follow `EVALUATION_STANDARD.md` for comparison and failure closure.

## Previously Admitted Work

| Change                                                             | Revision  | Status   | Preserved value                                                                 |
| ------------------------------------------------------------------ | --------- | -------- | ------------------------------------------------------------------------------- |
| Canonical task-event history and exact continuation reconstruction | `ef5b739` | admitted | One durable source for recovery, UI history, and model continuation             |
| Consolidated reproducible E2E harness                              | `2196fca` | admitted | Rebuildable environment, immutable results, and baseline comparison             |
| Defer network reader definitions until capture starts              | `a74eebb` | admitted | Smaller non-network tool surface while retaining the visible start capability   |
| Bound persisted panel history reads                                | `c44e135` | admitted | Bounded UI/history loading without changing model task evidence                 |
| Compact ordinary scroll model output while retaining audit output  | `701f903` | admitted | Lower repeated traversal output without weakening full audit evidence           |
| Retry transient invalid Provider responses up to three attempts    | `c6e129c` | admitted | Better tolerance of transient Provider failures with persisted retry evidence   |
| Exact history lookup for message replies                           | `59f6906` | admitted | Deterministic reply context without replaying unrestricted conversation history |

## Reference-Derived Decisions

| Reference idea                                                     | ChatBrowserX decision                                                                                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BrowserAct runtime Skill loading                                   | Keep the browser core native; evaluate progressive discovery only for large optional Skill catalogs.                                                                                |
| agent-browser filtered and scoped snapshots                        | Retain semantic refs and bounded AX inspection; evaluate targeted reads without replacing the AX/DOM/screenshot stack.                                                              |
| Hermes session search and tool discovery                           | Queue explicit cross-conversation retrieval and optional-tool discovery; do not add automatic long-term memory.                                                                     |
| OpenAI lean prompts, deferred tools, and programmatic tool calling | State shared policy once, but keep action-critical preconditions beside the action tool; defer native discovery and read-only orchestration until dedicated workloads prove a gain. |
| Claude permission and takeover patterns                            | Keep provenance, approval boundaries, and human takeover as a later safety phase rather than coupling them to Token optimization.                                                   |

An admitted label records the repository decision that retained the change. It is not a substitute
for a new baseline run when a later candidate is compared.

## Candidate Backlog

| Phase | Candidate                                                                                                                                        | Expected benefit                                                                  | Cost            | Risk           | Status    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------- | -------------- | --------- |
| 0     | Preserve cache-write Token, first-event/first-text latency, tool-definition size, and schema-change evidence in portable results and comparisons | Makes performance claims reproducible; no product behavior change                 | Small           | Very low       | admitted  |
| 0     | Verify required Sandbox connection settings before submitting a live task                                                                        | Separates environment failures from product failures without spending a model run | Very small      | Very low       | admitted  |
| 1A    | Stable opaque Responses `prompt_cache_key` per conversation or WorkSession                                                                       | Better cache routing and potentially lower billed input and time to first event   | Small           | Low            | rejected  |
| 1B    | Bounded head-tail Sandbox command projection with an omission marker                                                                             | Retains terminal errors under the existing output budget                          | Small           | Very low       | admitted  |
| 1C    | Tell the model to wait and re-inspect whenever delayed UI is absent after a click                                                                | Potentially avoids premature shortcut or target switching                         | Very small      | Low            | rejected  |
| 2A    | Deduplicate shared policy from `browser_inspect` and `browser_scroll` schemas while retaining action-local hard guards                           | Smaller repeated tool definitions and more reliable scope selection               | Medium          | Medium         | admitted  |
| 2B    | Compact `browser_inspect` model projection while retaining full audit output                                                                     | Fewer observation Tokens on document-heavy pages                                  | Medium          | Medium         | rejected  |
| 2C    | Read-only semantic `browser_find` and ref-scoped inspection                                                                                      | Fewer full-tree reads and model rounds for targeted tasks                         | Medium          | Medium         | queued    |
| 2D    | Stabilize common browser schemas and validate dynamic refs in the executor                                                                       | Fewer schema changes and potentially better cache reuse                           | Medium          | Medium         | queued    |
| 2E    | Prioritize editable targets in the bounded interactive ref budget and disclose deferred image delivery after capture                             | Keeps dense-page editors actionable without broadening the page snapshot          | Very small      | Low            | admitted  |
| 2F    | Classify fragment links as `same-page` from native DOM link semantics                                                                            | Gives generic navigation policy reliable table-of-contents evidence               | Small           | Low            | admitted  |
| 3A    | Load installed Sandbox Skills through a hidden `skill_loader` system-prompt contributor only when Sandbox is reachable                           | Removes catalog/search coupling and avoids exposing unusable Sandbox capabilities | Small           | Low            | admitted  |
| 3B    | Native deferred discovery for optional, non-browser tool families                                                                                | Lower large-tool-set prompt cost without hiding browser core tools                | Medium to large | Medium         | queued    |
| 3C    | Read-only programmatic orchestration for many independent network or history reads                                                               | Fewer model round trips on proven fan-out workloads                               | Large           | Medium to high | queued    |
| 3D    | Cross-conversation FTS retrieval with search-then-read IDs, excluding automatic memory                                                           | Reuse prior task evidence without replaying full conversations                    | Medium to large | Medium         | queued    |
| 3E    | Generic goal, completion-evidence, and no-progress state outside browser execution                                                               | Reduce drift and repeated calls in long Sandbox, network, or history tasks        | Medium          | Medium         | queued    |
| 3F    | Bounded semantic ownership, explicit visual fallback, consistent deltas, and existing-context browser/Skill guidance                             | Reduce ambiguous targets, premature screenshots, and redundant read operations    | Small to medium | Medium         | measuring |
| 4     | Content provenance boundaries, domain/action policy, and credential isolation                                                                    | Stronger resistance to page-originated instruction and unintended actions         | Large           | Medium to high | queued    |
| 4     | Explicit human takeover for CAPTCHA, 2FA, and approval-only states                                                                               | More recoverable blocked tasks                                                    | Large           | Medium         | queued    |

## Explicit Non-Candidates

The following are excluded unless a future reproducible defect changes the decision:

- replacing the AX/DOM/screenshot browser observation stack;
- a general `read_all` path;
- hiding core browser tools behind generic tool search;
- general batching or parallel execution of browser mutations;
- model-visible raw JavaScript or CSS selectors as the default interaction path;
- custom context compression in place of exact encrypted-reasoning replay;
- multi-provider fallback, multi-agent execution, automatic Skill mutation, or long-term memory;
- stealth or CAPTCHA-bypass behavior.

## Decision Record

For each candidate, update only its row and append one concise entry containing the date, product
revisions, sample counts, success rates, relevant mean/P95 deltas, and the admit/reject reason. Raw
attempt facts remain in each ignored sample's `benchmark/` directory; do not
duplicate them here.

- 2026-08-29 — Phase 0 admitted against unchanged product
  `59f69065fad47886f63adc97897cae6858a3e870`. Deterministic evidence checks passed 124/124,
  repository tests passed 1277/1277, browser tests passed 8/8, and the named-section live smoke
  passed 1/1. Its v3 result retained Cache, latency, tool-contract, schema-change, and per-tool
  output facts without changing product code.
- 2026-08-30 — Phase 0 comparison integrity was tightened after a stale profile-lock attempt
  exposed an overloaded failure field. Product task errors and timeouts now remain valid failed
  outcomes for success-rate comparison, while environment, harness, and evidence failures are
  recorded separately and invalidate both success-rate and performance deltas. Deterministic
  regression tests cover both sides; no product code changed for this correction.
- 2026-08-30 — Product baseline `59f69065fad47886f63adc97897cae6858a3e870` froze at named
  section 5/5, full analysis 5/5, messenger month 1/1, exam selection contract v2 1/1,
  LeetCode replacement 1/1, and browser network evidence 1/1. Two earlier exam preflight failures
  remain under contract v1 and are excluded from the product baseline.
- 2026-08-30 — Phase 1A rejected after comparing baseline `59f69065fad47886f63adc97897cae6858a3e870`
  with candidate `59f69065fad47886f63adc97897cae6858a3e870-dirty-03097de37b934ef5`.
  Named-section and full-analysis correctness both remained 5/5 versus 5/5. Named-section mean
  total Tokens fell 7.4% but latency was mixed; full-analysis mean total Tokens rose 13.2%, model
  rounds rose from 8 to 10, and cache-read ratio fell 0.44 percentage points. Every candidate
  request retained one stable opaque key, so the result showed no attributable cache-routing gain;
  one 17-round traversal outlier exposed existing model strategy variance. Phase 1A product and
  trace changes were removed while all immutable attempt results were retained.
- 2026-08-30 — Phase 1B targeted evidence compared isolated baseline
  `59f69065fad47886f63adc97897cae6858a3e870+phase1b-baseline` with candidate
  `59f69065fad47886f63adc97897cae6858a3e870-dirty-33a79e04560d1e01`. The baseline retained only
  the first 64 KiB and failed the diagnostic-tail contract 0/1; the candidate retained one bounded
  head-tail result and passed 3/3, with exactly one `sandbox_exec` call in every valid attempt.
  The persisted evidence remained redacted and capped at 50,000 characters while the in-memory
  evaluator used the complete 65,591-character durable fact. No Token or latency benefit is
  claimed. The final product revision then passed named section 5/5, full analysis 5/5, Messenger
  global search 5/5, Messenger month 1/1, network evidence 1/1, exam selection 1/1, and LeetCode
  replacement 1/1. Global-search baseline and candidate were both 5/5 with identical mean model
  rounds and tool calls. One earlier month attempt failed during an asynchronously delayed search;
  it is retained as a stochastic baseline-path failure because the first Provider contract was
  byte-identical and the isolated Phase 1B code cannot execute without a Sandbox call.
- 2026-08-30 — Phase 1C rejected after a dedicated Messenger global-search comparison between
  baseline `59f69065fad47886f63adc97897cae6858a3e870+phase1c-baseline` and candidate
  `59f69065fad47886f63adc97897cae6858a3e870-dirty-ab9e225e62c76d54`. Both passed 5/5, but the
  candidate added 2.0 mean model rounds, 2.0 mean tool calls, 53,636 mean total Tokens, and
  10,918 ms mean elapsed time; its P95 added 7 rounds and 185,433 Tokens. The generic wait hint
  caused excess inspection without a correctness gain, so its product and test changes were
  removed while the sample and immutable attempts were retained.
- 2026-08-30 — Phase 2A admitted after comparing frozen browser behavior
  `59f69065fad47886f63adc97897cae6858a3e870+phase2a-baseline-v16` with isolated candidate
  `59f69065fad47886f63adc97897cae6858a3e870+phase2a-final-v16`. Full-document analysis improved
  from 2/5 to 5/5: the three baseline failures all clicked table-of-contents links after page-wide
  traversal, while every candidate run verified the upper boundary before the lower boundary and
  used zero clicks. Candidate mean tool-definition characters fell 50.8%, tool calls fell from
  12.2 to 7.2, model rounds fell from 13.6 to 8.2, and total Tokens fell 11.7%. The Token and elapsed
  deltas include strategy variance, so only the schema reduction and correctness change are treated
  as strongly attributable. Named-section correctness remained 5/5 versus 5/5; its mean
  tool-definition characters fell 20.5%, total Tokens fell 8.3%, and the section remained bounded.
  Messenger month, network evidence, exam selection, and LeetCode replacement each passed 1/1.
  Early candidates exposed two necessary action-local guards: `browser_click` must reject TOC use
  for page-wide reading, and `browser_scroll` must require an upward boundary probe before downward
  traversal. Keeping these short guards beside their tools was more reliable than putting every rule
  only in the shared policy. Contract v16 also replaced brittle heading wording with concrete content
  evidence and accepted equivalent browser-supported top-navigation keys; no product behavior was
  changed for those E2E oracle corrections. Interrupted-run stale-lock results remain stored as
  harness failures and were excluded from the isolated candidate revision.
- 2026-08-30 — Phase 2A returned to measuring after a complete catalog run of revision
  `59f69065fad47886f63adc97897cae6858a3e870-dirty-86906759a022c70b+full-e2e-20260830` passed
  full-document analysis 4/5 instead of the stored Phase 2A batch's 5/5. Raw mean elapsed time rose
  38.7% because the failed attempt timed out after an unnecessary table-of-contents click. Among
  successful attempts, mean elapsed time fell 2.1% and total Tokens fell 15.6%, but resource savings
  cannot admit a correctness regression. The remaining single-run latency deltas were mixed and are
  not treated as attributable gains. Requalification requires an interleaved frozen-baseline batch
  under the multi-metric admission rule above.
- 2026-08-30 — Phase 2B rejected by static evidence before implementation. A representative
  14.3k-character document inspection contained about 13.7k characters of semantic elements; the
  removable envelope, URL, and empty fields were under 0.5k characters. A generic projection would
  therefore save only a few percent while risking loss of legitimate repeated table or list content.
  No production code was added, and targeted retrieval remains the safer queued direction.
- 2026-08-30 — Final integration gates passed 1291/1291 deterministic tests, 8/8 Playwright
  browser tests, TypeScript, ESLint, production bundle audit, Sandbox integration, and all 16 E2E
  catalog contracts. The stored Phase 2A full-document and named-section comparisons were reread by
  the final comparator with valid evidence on both sides. Repository-wide Prettier still reports the
  same three files that were already non-canonical at baseline; files changed by the admitted product
  optimization and this ledger pass Prettier, and `git diff --check` passes.
- 2026-08-30 — A broad device-pixel viewport trial
  `59f69065fad47886f63adc97897cae6858a3e870-dirty-d939e7bb53ef703c` fixed the dense-page editor
  omission but was rejected. Against same-period named-section evidence it raised mean total Tokens
  by 11.2%, model rounds and Tool Calls by 0.6, and scroll calls by 0.8. Its image-send attempt passed
  with 13 calls and 346,745 Tokens, but the viewport-wide evidence expansion was not necessary. The
  trial was replaced by editable-target priority under the existing budget; the regression test was
  observed red after restoring the original viewport selection and green after the narrow fix.
- 2026-08-30 — Phase 2A was re-admitted together with 2E and 2F on final product revision
  `59f69065fad47886f63adc97897cae6858a3e870-dirty-5d684894ec6a62e4`. Full-document analysis
  improved from raw 3/5 to 5/5 and from human-adjudicated 4/5 to 5/5 versus
  `59f69065fad47886f63adc97897cae6858a3e870+r1-baseline`; candidate runs used zero clicks,
  keypresses, screenshots, stale refs, or state mismatches. Mean total Tokens fell 20.0%, task time
  11.4%, model time 15.9%, rounds 24.5%, Tool Calls 27.3%, total tool-definition characters 40.8%,
  and maximum tool-definition characters 22.8%. P95 total Tokens fell 38.0% and task time 20.3%.
  The same-period named-section comparison against
  `59f69065fad47886f63adc97897cae6858a3e870+r2-named-baseline` was raw 4/5 to 5/5 and
  human-adjudicated 5/5 to 5/5. Mean total Tokens rose 4.3% and task time 1.6%, while P95 Tokens fell
  0.2%, mean scroll calls stayed 6.6, P95 Tool Calls stayed 10, total tool-definition characters
  fell 15.5%, and the maximum fell 24.1%. The sole baseline failure used equivalent wording; all
  five candidate attempts stayed within the requested section boundary.
- 2026-08-30 — The final 2E image-send attempt passed 1/1 with exactly one capture and one paste,
  independently verified send/readback, and a cleared editor. Compared with the rejected broad
  viewport pass it reduced model rounds from 14 to 10, Tool Calls from 13 to 9, and total Tokens
  from 346,745 to 182,271. The exact final revision also passed network evidence 1/1, exam selection
  1/1, Messenger August history 1/1, and LeetCode full replacement 1/1. The Sandbox diagnostic was
  intentionally not submitted because live verification now reports the missing Sandbox connection
  as a dedicated preflight failure.
- 2026-08-30 — Phase 2A's implementation was consolidated and requalified from stable revision
  `59f69065fad47886f63adc97897cae6858a3e870-dirty-5d684894ec6a62e4` to final revision
  `59f69065fad47886f63adc97897cae6858a3e870-dirty-0122021bdac6ff26`. One shared scope policy now
  owns browser-reading decisions while only click and scroll hard guards remain action-local; the
  fixed policy-plus-tool-description payload fell from 8,955 to 8,690 characters. Full analysis
  remained 5/5, with mean/P95 total Tokens down 7.2%/20.7%, mean/P95 task time down 2.0%/7.2%, and
  mean Tool Calls down from 6.4 to 6.0. Named-section evaluation passed 5/5 plus a same-code 5/5
  confirmation batch; across all ten attempts, mean Tokens, task time, model time, and Tool Calls
  fell 4.6%, 6.7%, 7.0%, and 3.3%. Two rejected intermediate attempts remain stored: one inferred a
  distant boundary from AX depth and table-of-contents order, and one stopped at a container's first
  child heading. The final generic container rule fixed both without a site-specific path. Provider
  first-event tails varied and are not claimed as a product gain. A harness-only correction also
  recognizes an explicitly failed HTTP response followed by its successful durable retry; no
  production retry or acceptance rule was relaxed.
- 2026-09-01 — Phase 3A and the decoupled Agent/Provider/tool registry were retained against frozen
  baseline `384db2b20c901d65a16fd9765eac5861d9de91a5+baseline`. The final functional candidate
  `384db2b20c901d65a16fd9765eac5861d9de91a5-dirty-81dfd29184960080` passed every current
  contract (16/16); the baseline passed 9/16. Full-document and named-section candidate batches
  passed 5/5 each, while the fail-fast baseline stopped at 0/1 in both because its always-present
  Skill catalog redirected the task from browser tools to the local `lark-doc` Skill. Messenger
  global search remained 5/5 on both sides; candidate mean total Tokens fell from 98,768.6 to
  70,828.2 (28.3%), while mean elapsed time rose from 30,083 ms to 32,169 ms (6.9%) alongside a
  5.3% increase in mean Provider request latency, so no speed gain is claimed for that batch. The
  repeated baseline prompt carried 17,966 instruction characters per request versus 1,612 for the
  candidate. Across the nine one-attempt contracts that succeeded on both revisions, aggregate
  total Tokens, elapsed time, Tool Calls, and model rounds fell 50.9%, 12.8%, 9.2%, and 8.1%; these
  aggregate single-attempt figures support direction only, not per-sample stability claims. The
  other baseline failures reproduced missing native send/search controls, image-paste verification,
  and page-content instruction interference; current attempts completed their required readbacks.
  After lint-only equivalent loop/constant cleanup changed the dirty fingerprint to
  `384db2b20c901d65a16fd9765eac5861d9de91a5-dirty-0daba3c3913dcaf0`, native-button send and
  virtualized multi-group scrolling passed fresh live smokes. Repository gates passed 1348/1348
  unit tests, 8/8 Playwright tests, formatting, lint, TypeScript/build, bundle audit, Sandbox
  integration, and all 16 catalog contracts.
- 2026-10-20 — Phase 3F remains **measuring**, not a measured latency/Token improvement. The
  candidate is `494a9875393d71a3c8874db7aa21ec4da95460bc-dirty-670b30c3f75f7845`; the frozen production worker
  has SHA-256 `e5793dbc53582d56bc2ef19e5c169c39c2b823b9acdc8090dabc8def79146e81`.
  Browser actions now carry up to four semantic owners; deep inspection alone no longer authorizes
  screenshot fallback, while an explicit missing-target/visual reason remains available. Screenshot
  input mapping uses fractional CSS viewport dimensions rather than deprecated device-pixel metrics.
  Scroll deltas keep their keyed entries, removals and coverage, including after a full snapshot
  replaces the delta base. Existing context carries batch scope, exclusions, verified/uncertain
  outcomes and a working procedure; no second task-state system or site-specific rules were added.
  Skill guidance honors the user's selected CLI/browser, reuses in-context instructions/results,
  and prefers direct bounded output over default file/pretty-print/refetch chains. Installed Skill
  files and the discovery/cache mechanism were not changed.
  A trial hard stop on repeated dispatched actions was rejected by a counterexample: unchanged AX
  evidence does not imply an ineffective action (for example, visual zoom controls). The candidate
  instead adds a soft replan advisory after four explicitly unchanged observations and keeps existing
  failure/replay guards. New deterministic browser regressions passed at DPR 2 with 100%/150% zoom
  and for a two-item scoped-ref move with a same-name body control and excluded subtree. The fixture
  initially misread multimodal receipts and selected a tree row instead of its button; both harness
  failures were preserved under `e2e/.runtime/optimization-evidence/browser-skills/` and corrected
  without relaxing acceptance or changing production behavior. Real user documents were not moved.
  Repository validation passed 1775/1775 unit tests, 294/294 unfiltered Playwright tests (5.9 minutes),
  formatting, lint, TypeScript/build, bundle audit, Sandbox integration and all 39 catalog contracts.
  The existing Sandbox-tail sample failed standalone readiness before task submission: example.com
  now contains "Example Domain" only in its title, while the frozen contract requires it in body
  text. This is an external target/contract mismatch, not an observed product execution failure;
  the contract was not loosened and no live success was manufactured.
  The read-only named-document sample also failed standalone verification: its actual target origin
  differed from the declared origin and the document URL/body readiness checks failed. No task was
  submitted for either sample, so there is no current live-model acceptance or latency comparison.
  Ownership metadata and explicit guidance add bounded context, so lower total cost or improved
  autonomous batch completion must still be established by paired live samples; synthetic tool
  sequences do not establish those claims.
- 2026-10-21 — Phase 3F remains **measuring**; the user's bulk-move acceptance is **not met**.
  The focused candidate adds explicit hierarchy/raw scalar DOM evidence, bounded scoped inspection
  with fresh references, independent-child hit protection, and generic expand/collapse action hints.
  Production code contains no site/domain, document identity, directory-name or fixed workflow rules.
  Independent exact-set inventory first failed by including 17 excluded descendants, then passed
  after ordinary observations retained bounded structural evidence. The same authorized bulk-move
  contract failed three times: independently verified progress was 3/26, 4/26 and 7/26, with all
  19 enumerated exclusion checks unchanged on every run. Moved items are preserved, not replayed
  or restored. Later runs also failed the frozen attachment limit; that limit was not relaxed.
  The latest run ended after 41 tools / 42 turns / 377.957 seconds while its final answer still
  listed pending work. There was no provider retry, context compaction, exhausted budget or concrete
  external blocker. Stronger persistence guidance and named expansion controls were insufficient:
  text-only final replies still end a task, and the existing completion hook only checks unfinished
  scrolling. A generic task-progress/end-condition change needs a scope decision; it has not been
  silently added to this browser-only plan.
  A separate real-model TodoMVC control passed 1/1: create five uniquely named items, complete four,
  preserve the excluded fifth, and independently read all five states after reload (9 tools,
  10 turns, 35.520 seconds, zero screenshots). This small control does not cover the remaining
  long-tree/batch-completion failure. Focused browser mechanisms passed 9/9, repository unit
  tests passed 1812/1812, and the unfiltered browser gate passed 296/296 in 5.8 minutes. Formatting,
  lint, typecheck/build, bundle audit, Sandbox integration and catalog validation passed; the
  existing NO_COLOR/FORCE_COLOR environment warning remains. All attempts remain immutable in
  the ignored sample collections. Changed remote initial states prevent a paired latency or
  success-rate improvement claim; the candidate is retained uncommitted pending the user's decision.
- 2026-10-21 — The user authorized a bounded generic progress/completion extension and requested
  removal of ad hoc instructions. `task_progress` now upserts stable-ID items in existing durable
  tool results, without a new store or workflow engine. The existing final-answer boundary checks
  recorded pending/uncertain work and inventory coverage, pauses for an explicit blocker, and bounds
  repeated finals without intervening work. Resume and new input invalidate stale readiness; user
  cancellation retains priority. Tools expose real, bounded evidence call IDs; provenance validation
  does not replace independent business readback. Reading an empty ledger does not activate a workflow.
  Browser runtime workflow instructions/advisory counters were removed, as were extra Skill execution
  suggestions; user instructions, Skill loading/safety rules, and necessary tool contracts remain.
  The first real control failed because the model used a snapshot ID where the tool required a call
  ID that its receipt did not expose. That usability defect has RED/GREEN and extension regressions.
  The next control completed, but its first independent readback failed to create a browser page;
  four later readbacks passed. A separate read-only check verified all five original states, without
  changing that failed report. The exact one-off page-creation cause remains unproven; no speculative
  retry or weaker acceptance was added. The latest frozen control passed all five independent
  assertions with 13 tools / 14 turns / 89.559 seconds, zero screenshots/provider retries, and one
  recovered stale reference. One pass is not a stability claim or a paired performance improvement.
  Current full unit validation passed 1832/1832 across 145 files; formatting, lint, build, bundle
  audit, Sandbox integration and 44 sample contracts passed. The complete frozen browser gate passed
  297/297 in 7.4 minutes. The real bulk attempt remains FAILED: it recorded all 19 pending items,
  moved four, and attempted two premature final replies that the new guard rejected. It then paused
  after Provider transient retries were exhausted (four retries across the run, 28 tools / 30 model
  turns / 612.225 seconds). Final failed requests included the forced progress tool and complete
  call/output pairs; captured terminal response bodies were unavailable, so the precise upstream
  cause is unproven. This is not evidence of reliable autonomous batch completion, even apart from
  Provider availability. All requests had zero instruction characters and no screenshots were used.
  A separate read-only audit through the common runtime checked all 45 frozen page assertions:
  11/26 documents are now under the destination, 15/26 remain at root, and all 19 enumerated exclusion
  checks remain unchanged. It did not rewrite the failed report or replay uncertain mutations.
  The user's full-task acceptance is still not met. All changes remain uncommitted.
- 2026-10-21 — The final generic completion-feedback correction meets this user's original
  bulk-move acceptance. The prior candidate still failed at 13/26 moved: a rejected final replayed
  identical input with a forced progress-only tool contract and no rejection feedback. Two RED
  regressions reproduced that defect. The planner now projects the existing review as explicitly
  labeled runtime input data, leaves normal tools available, and clears it after a tool result.
  Progress receipts and final gating share one bounded phase/count/next-action calculation;
  unsuccessful updates retain the prior ledger. No system instructions, new state store, site rules,
  automatic mutation replay, or larger retry budget were added. Provider failure diagnostics retain
  safe enum stages, not raw upstream text.
  The unchanged real contract then passed with all 45 independent assertions (26 authorized
  candidates at destination and 19 enumerated exclusions unchanged). This attempt moved the last
  13 distinct candidates, using 56 tools / 69 completed model turns / 726.987 seconds, zero
  screenshots/stale refs/state mismatches, and two recovered upstream errors. Twelve premature
  final replies were rejected and followed by real work; one invalid evidence ID was rejected and
  repaired. These overheads remain visible, so this is not a zero-error or optimal-efficiency claim.
  After full verification, a separately authorized plugin task returned three original candidates
  for manual testing. It also passed all 45 independent assertions: three at root, the other 23 at
  destination, and the same exclusions unchanged; 23 tools / 24 turns / 145.844 seconds, no retries,
  screenshots or stale refs. Every request in both attempts had zero instruction characters.
  A real-model delayed/virtualized synthetic batch also passed all four reloaded parent assertions
  before the final continuation correction (22 tools / 23 turns / 132.912 seconds). Deterministic
  coverage on the final build passed 1837/1837 unit tests and the focused extension completion case;
  the final unfiltered browser gate passed 297/297 in 6.3 minutes. Formatting, lint, typecheck/build,
  bundle audit, Sandbox integration and catalog validation also passed. All earlier failed reports
  remain immutable.
  Changing remote initial state precludes a paired performance comparison or broad reliability
  claim. Task elapsed excludes independent post-task readback; the two real passes required about
  137 and 128 additional seconds for readback/reporting. Phase 3F remains measuring for general
  performance, while the concrete task and user-requested manual-test preparation are verified.
- 2026-11-13 — Bounded follow-up to the framework migration retains complete conversation history.
  Network detail arguments now enumerate IDs actually disclosed by the current capture; request ID
  formats and exact runtime lookup are unchanged. The progress-tool description scopes its ledger
  requirements to opted-in multi-deliverable tasks. A registered `load_tools` exposes optional
  Provider tools on demand, using durable current-task receipts and no extra system instructions.
  The first candidate still overused progress once and skipped an explicit search once; both
  failures remain recorded, followed by narrower tool-description corrections. E2E also omitted
  the existing `providerHosted` flag from current snapshots and rejected it in saved results;
  two regression tests reproduce that harness defect, and both boundaries now retain the flag.
  Against the frozen same-capability `20f7e92a6a7fa7bf` reference, candidate `a06992dfa4441b7f`
  passed network 2/2 (`092355.523Z`, mean 62,470 Tokens / 26.848 seconds) and public MDN reading
  2/2 (`092654.146Z`, mean 17,582.5 Tokens / 6.994 seconds). Native search passed 2/2
  (`092254.485Z`) but costs 16,862.5 Tokens / 12.613 seconds versus 12,400.5 / 7.230 seconds:
  the explicit loading turn is a measured trade-off, not an improvement for search-only work.
  The final editor batch (`092514.489Z`) passed once and hit a Cloudflare challenge once without
  writing; standalone readiness recovered and one further unchanged-contract attempt passed
  (`092840.780Z`). Do not use the blocked attempt's lower usage as a performance gain. All batch
  timestamps above have the prefix `20261113T` and live under their sample's `benchmark/` directory.
  Earlier regressions remain in editor batch `090425.037Z` and search batch `091301.277Z`;
  the hosted-evidence harness failure remains in search batch `091504.312Z`.
  Scoped validation passed 243 tests across 19 files, touched-file formatting/lint, typecheck,
  build, and all 47 sample contracts. E2E used the frozen candidate build; subsequent concurrent
  selection-translation changes are outside these live results. These small samples are not a
  reliability guarantee. Changes remain uncommitted.

- 2026-11-13 — Network references and Provider cache affinity (bounded follow-up).
  The network reader no longer repeats listed IDs in its JSON schema. It reuses the existing
  compact browser-reference function, keeps exact legacy-ID lookup, and validates disclosure in
  the owning frozen capture. Pagination, invalid IDs, old captures, and alias deduplication have
  regression coverage. No request content is discarded.
  A fixed-input diagnostic found zero reported cache reads across three identical requests.
  The official Codex client uses a stable `session-id` header for ChatGPT cache affinity. Changing
  only that header (identical serialized request-body hashes) produced 6,912 cached input Tokens
  out of 7,515 on both warm repeats, while all three unkeyed controls reported zero. The Provider
  interface now accepts an optional generic session ID; only the Codex backend maps it to a header.
  Normal model calls and compaction share the conversation ID. No request-body cache options,
  server-side conversation state, global instructions, or dependencies were added.
  Source: https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs
  and https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/requests/headers.rs.
  Frozen local baseline `f76f1a86a7a98d0e` and final candidate `9239e26d7a705d46` each passed
  network 2/2, batches `20261113T100937.085Z` and `20261113T102125.654Z`. Both used seven model
  requests and six identical tool calls per attempt, with no retries, compaction, screenshots,
  stale refs, or mismatched evidence. Mean total Tokens fell from 62,750.5 to 53,816 (-14.2%),
  uncached input from 51,396.5 to 16,891.5 (-67.1%), task time from 28.182 to 23.9935 seconds
  (-14.9%), and total Provider time from 24.728 to 20.091 seconds (-18.8%). Formal comparison
  reports valid evidence and comparable success/performance metrics. All instructions were empty.
  The intermediate short-reference-only batch `20261113T101250.973Z` remains preserved; one
  attempt skipped a wait, so it must not be used to attribute every saved Token to schema size.
  Runtime diagnostics and frozen manifests are under `e2e/.runtime/network-cache-followup/`.
  Scoped validation passed 144 tests in 13 files, touched-file formatting/lint, typecheck, and build.
  This is positive evidence for the affected network path, not a full-matrix or long-run reliability
  claim. Broader admission remains measuring; changes are uncommitted.

## Remaining Framework Follow-ups

These are proposals, not authorization to widen the current implementation. Long-term memory is
excluded. Preserve complete model-visible history until compaction and keep system instructions
limited to user configuration and registered tool contributions.

| Priority | Candidate                                                                              | Expected benefit                                                                           | Cost / main risk                                                                                    | Status       |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------ |
| P1       | Natural long-context compaction and restart/interruption replay                        | Correctness evidence for long sessions; detect lost evidence and duplicate effects         | Natural compaction passed with the live Provider; controlled cancellation and restart checks passed | scoped pass  |
| P1       | Stable tool contracts across task phases                                               | Better cache reuse without discarding history                                              | Measured changes are useful tab/scroll constraints; retain them                                     | measured     |
| P1       | Remove the explicit loader round when search capability is already known by the caller | Lower search-only latency and model-request overhead                                       | Medium; avoid keyword routing and preserve the non-search savings of lazy loading                   | queued       |
| P2       | Restore the saved native window before reading all historical messages/tasks           | Lower local startup I/O and memory in long conversations; no model Token reduction claimed | Implemented indexed message reads; task metadata still loads for history tools                      | scoped pass  |
| P2       | Audit existing bounded browser snapshot differences and full-read fallback             | Find measurable missed reuse without introducing another diff implementation               | Already implemented in PageObserver; further optimization requires evidence                         | audit queued |
| P2       | A second real Provider contract run                                                    | Prove backend extensibility beyond the existing foreign-wire-format fixture                | Medium; authentication, usage, hosted tools, and compaction must all map correctly                  | queued       |
| P3       | Cross-conversation exact history search                                                | Reuse prior evidence without replaying unrelated sessions                                  | Medium; explicit access scope and indexing needed; this is not long-term memory                     | queued       |
| P3       | Stateful/incremental transport or a native Agent harness                               | Less repeated upload and less custom lifecycle ownership                                   | High; process deployment, reconnect, protocol, and recovery risks; no rewrite planned               | queued       |

### 2026-11-13: Scoped lifecycle and message-read follow-up

- Starting artifact: `081eb45a627d64439b5b0836e4c5416bd638cb28-dirty-9239e26d7a705d46`.
  Lifecycle/I/O candidate: `...dirty-57aae4c29f3edab6`; final contract clarification:
  `...dirty-454d57b49e18471d`. Frozen artifacts, original files, diagnostics, and failed evidence
  are retained under `e2e/.runtime/agent-lifecycle-followup/`. Changes remain uncommitted.
- A cancelled SDK stream can end without a terminal answer. Check cancellation before reporting
  `INVALID_RESPONSE`; do not weaken completed-response validation. Cancellation before tool
  dispatch and during compaction now pass, preserving receipts and queued supplements.
- Saved native sessions use existing task-indexed message reads plus explicit older reply targets.
  Preserve chronological supplement order, the history-tool task catalog, and full reconstruction
  for records without a native window. Exact model-input equality passes with a compacted window,
  old image reply, two supplements, and 1000 unrelated messages. No model Token savings claimed.
- Isolated real-Chromium IndexedDB measurements (five alternating reads after warmup, 4060 text
  characters/message, four relevant messages): 100 messages 0.92 -> 0.12 ms; 1000 messages
  17.60 -> 1.02 ms; 10000 messages 138.30 -> 0.30 ms. These are local read costs, not total task
  latency. The final case avoids materializing 40.6 MB of unrelated message text.
- Schema attribution found capture-tab binding (-231 characters once, then stable) and scroll-ref
  binding (+88 characters). Both remain. A new real network failure captured 180 requests but the
  model used a regex-escaped URL filter against literal substring matching. Clarify the field's
  existing semantics; no regex support, site logic, automatic retry, or acceptance relaxation.
  Preserve failed batch `browser-network-evidence/20261113T110731.518Z`. The corrected frozen
  contract passed 5/5 in `20261113T111046.282Z`: mean 52576.6 Tokens, 27.664 s, 5.8 tool calls,
  and 24.282 s Provider time per task. This is scoped correctness evidence, not a speed claim.
- Controlled reply/history browser tests passed 5/5, including actual Worker stop/restart during
  compaction recovery. Scoped unit/integration runs passed 118 tests and 195 network-contract
  tests (overlapping scopes), with formatting, lint, typecheck, and build passing. The build's
  pre-existing `inlineDynamicImports` warning is unchanged from the starting artifact.
- Natural compaction remains unverified: catalog discovery succeeded but returned only
  `codex-auto-review`, not configured `gpt-5.6-terra`. Two diagnostic precondition failures sent
  no model requests. Do not guess the missing window, override a threshold, switch models, or
  describe the controlled compaction tests as natural long-session validation.
- The final frozen candidate also passed the MDN read-only smoke 1/1 in
  `translation-mdn-readable/20261113T111433.659Z`; the earlier I/O-only smoke remains in
  `20261113T110719.349Z`. Full-matrix and natural-long-context acceptance are not claimed.
- A separately labeled frozen-baseline control (`...dirty-9239e26d7a705d46+lifecycle-control`,
  `browser-network-evidence/20261113T111730.124Z`) requested five attempts and stopped on its first
  substantive failure: 181 requests captured, regex-escaped literal filter, zero matches, missing
  `browser_network_get`. This reproduces the contract defect before the current I/O/cancellation
  changes. It is 0/1 executed, not 0/5. Its incomplete-task Tokens/time cannot be compared against
  successful candidate runs; no end-to-end performance gain or five-by-five result is claimed.

### 2026-11-14: Archived-answer retrieval

- Added declared `initialHistory` fixtures to the shared live runner. Synthetic archived tasks
  remain in durable storage while a summary-only model window omits their answers. Authentication,
  execution, evidence collection, and immutable reports use the normal runbook. This tests real
  model retrieval decisions, not natural context compaction or actual cancellation of remote work.
- Frozen samples: `history-recall-exact`, `history-recall-paraphrase`, and
  `history-recall-interrupted`, three attempts per candidate. No site mutation is authorized.
- The first revision passed exact quotation 3/3 and interrupted-status recall 1/1, but paraphrased
  recall only 2/3. Failed evidence is preserved in
  `samples/history-recall-paraphrase/benchmark/20261113T222142.698Z/02.json`: four keyword searches
  returned only the current question or no matches; the model declared the answer unavailable
  without browsing. All five Provider responses completed successfully, with no retry or harness
  failure. The answer remained in the archive and was recovered in the preceding two attempts.
- Smallest correction: clarify only `history_search`'s existing empty-query browse behavior before
  declaring information unavailable. No global instructions, matching algorithm, sample input,
  acceptance conditions, or storage format changed.
- Candidate `...dirty-658fcbf8dcc45f70` passed all three samples 3/3 each. Exact quotations also
  matched the complete stored answer after removing presentation whitespace/blockquote markers.
  All nine first-request window checks passed; no Provider retries or remote writes occurred.
  The initial candidate was `...dirty-cd79f6e022697bf1`; its failed report remains immutable.
- Paraphrased recall changed from 2/3 to 3/3. Including the original failed attempt, mean total
  Tokens were 32,254 -> 23,592.667, tool calls 5 -> 3.333, elapsed time 17.833 -> 14.434 seconds,
  and cumulative Provider time 16.477 -> 13.333 seconds. Uncached input was 9,314 -> 9,193.667
  Tokens, so total-token reduction is not an equivalent billing reduction. Candidate tool counts
  were 2, 3, and 5; the description improves recovery but does not guarantee the minimum calls.
- Exact recall stayed 3/3 and two tools/three Provider requests, with mean total Tokens
  17,770 -> 17,926.667 (+0.9%) and elapsed time 19.556 -> 19.533 seconds. This small contract cost
  is retained for the recovery improvement. Interrupted recall passed 3/3 at mean 22,022.667
  Tokens, three tools/four requests, and 13.313 seconds; the earlier 1/1 is not an equal-size baseline.
- Candidate batches: exact `20261113T222556.212Z`; paraphrased `20261113T222356.695Z` (one attempt)
  and `20261113T222445.053Z` (two); interrupted `20261113T222717.404Z`. Each is below its sample's
  `benchmark/` directory with per-attempt facts and the derived batch report. These synthetic,
  small-archive live runs are scoped evidence, not broad semantic-search or compaction guarantees.

### 2026-11-14: History search efficiency and full quotation

- The slow paraphrased attempt spent four keyword calls on empty or current-question matches. The
  reader now skips the current input when searching and emits each context excerpt once per page.
  Matched message IDs, chronological paging, and anchored reads are retained. The tool description
  is shorter and directs the model to recent history when literal search is unhelpful.
- Compare `...dirty-658fcbf8dcc45f70` with `...dirty-fcb34be4f061330c` using three sequential attempts
  per side of each frozen v1 sample. All three stayed at 3/3. Provider tool definitions were 363
  characters shorter per request. The paraphrased browse response fell from 3,830 to 2,309
  characters and its maximum calls fell from five to three. Two literal misses still preceded
  each successful browse.

| Sample             | Mean total Tokens | Mean elapsed seconds | Mean tool calls |
| ------------------ | ----------------- | -------------------- | --------------- |
| Exact recall       | 17,927 → 16,623   | 19.53 → 19.58        | 2.00 → 2.00     |
| Paraphrased recall | 23,593 → 20,212   | 14.43 → 13.01        | 3.33 → 3.00     |
| Interrupted recall | 22,023 → 18,442   | 13.31 → 12.80        | 3.00 → 2.67     |

- Mean first-text latency rose from 1.32 to 1.71 seconds for exact recall and from 1.19 to 2.16
  seconds for interrupted recall. These small, sequential batches establish the observed latency
  difference. Attribution and broader performance admission remain open.
- A stronger browse-first description (`...dirty-864f54801de18f50`) used one tool in two of three
  paraphrased attempts. Its interrupted batch stopped after one pass in two attempts. The failed
  answer used objects in `unconfirmed`, whose contract requires task-name strings. Both statuses
  and supporting facts were correct.
  Retain `samples/history-recall-interrupted/benchmark/20261114T024009.664Z/02.json`. The frozen
  acceptance criterion stands and the more conservative description is retained.
- Full-quote acceptance now rejects a missing passage even when every marker survives. The
  strengthened `history-recall-exact` v2 passed 3/3 in `20261114T024324.629Z`. The new
  `history-recall-paginated` passed 3/3 (`20261114T023536.845Z`, `20261114T024424.991Z`), twice
  advancing through `nextCursor` to an answer behind 16 newer messages and once finding it directly
  by keyword. All quotes matched in full. The model catalog still lists only `codex-auto-review`
  for this Profile, so the configured model's natural compaction remains unverified.
- The comparable v1 runs are in exact batch `20261114T022746.645Z`, paraphrased batches
  `20261114T022717.107Z` and `20261114T022847.659Z`, and interrupted batch `20261114T022918.281Z`.

### 2026-11-14: Model catalog, native compaction, and short history fallback

- The old catalog client version returned only a hidden auto-review entry. The updated version
  returned the configured model's 272,000-token context window and supported reasoning efforts.
  Settings suggestions honor the Provider's visibility flag. Explicit model IDs retain access
  to their capability metadata.
- A keyword miss can include one recent excerpt page when no individual term matches and the
  entire readable archive fits the requested page. The exact-match fields and cursor semantics
  are preserved. Repeat calls can reference an identical page still in the model window. The
  durable report retains the full result. Tool definitions matched the baseline in all four samples.
- An unbounded fallback repeated payloads on a paginated sample and raised mean total Tokens
  from 32,969 to 39,638 in batch `20261114T032600.506Z`. Other candidates omitted an interrupted
  task's status or produced objects where the answer contract requires task-name strings. Failed
  attempts remain in the interrupted sample's `20261114T031448.130Z/02.json` and
  `20261114T034429.991Z/02.json`. No acceptance conditions changed.

| Frozen sample      | Passes    | Mean total Tokens | Mean model seconds | Mean tool calls | Mean elapsed seconds |
| ------------------ | --------- | ----------------- | ------------------ | --------------- | -------------------- |
| Exact recall       | 3/3 → 3/3 | 16,586 → 16,617   | 18.28 → 18.09      | 2.00 → 2.00     | 19.33 → 24.83        |
| Paraphrased recall | 3/3 → 3/3 | 20,212 → 12,108   | 11.11 → 6.84       | 3.00 → 1.33     | 13.01 → 15.64        |
| Interrupted recall | 3/3 → 3/3 | 18,442 → 18,437   | 11.59 → 11.54      | 2.67 → 2.67     | 12.80 → 19.09        |
| Paginated recall   | 3/3 → 3/3 | 32,969 → 32,755   | 25.32 → 25.29      | 4.33 → 4.33     | 26.98 → 32.27        |

- Compared `...dirty-fcb34be4f061330c` with `...dirty-0c7448f3320a33a1`. Candidate batches in
  table order are `20261114T035234.996Z`, `20261114T035006.377Z`, `20261114T034857.410Z`, and
  `20261114T035055.745Z`. Paginated recall used a cursor in two of three attempts on each side.
  Its mean first-text time within the text-producing model call rose from 1.52 to 1.68 seconds.
- Stored task timestamps place the slow first attempts' 17–19 seconds before task creation.
  Inside those tasks, model time accounted for all but 0.13–0.29 seconds. A timed smoke
  (`20261114T041039.292Z`) spent 16.45 seconds opening the target in the runner and 22 ms
  submitting the task. Two earlier timed runs opened the same target in about one second.
  Keep the elapsed results as measured. This comparison supports the paraphrase Token and
  model-round improvement. Elapsed and first-text performance admission remains open.
- The live native-compaction sample starts with a synthetic uncompressed archive and uses actual
  Provider usage and the configured context limit. Batches `20261114T035351.931Z` and
  `20261114T040528.834Z` verified a Provider compaction item, its replay, and full quotation via
  history. Each took four Provider requests and two tools. Controlled browser checks separately
  covered restart after cancellation and attachment reuse.
- On the final settings build (`...dirty-1611276fe2a970ae`), a live UI check found 8 suggestions
  out of 10 catalog entries, verified the configured model's metadata, and confirmed a manually
  entered hidden model still uses the catalog's reasoning default. The same build passed the
  timed paraphrase smoke.
