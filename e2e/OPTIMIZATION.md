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

| Phase | Candidate                                                                                                                                        | Expected benefit                                                                  | Cost            | Risk           | Status   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------- | -------------- | -------- |
| 0     | Preserve cache-write Token, first-event/first-text latency, tool-definition size, and schema-change evidence in portable results and comparisons | Makes performance claims reproducible; no product behavior change                 | Small           | Very low       | admitted |
| 0     | Verify required Sandbox connection settings before submitting a live task                                                                        | Separates environment failures from product failures without spending a model run | Very small      | Very low       | admitted |
| 1A    | Stable opaque Responses `prompt_cache_key` per conversation or WorkSession                                                                       | Better cache routing and potentially lower billed input and time to first event   | Small           | Low            | rejected |
| 1B    | Bounded head-tail Sandbox command projection with an omission marker                                                                             | Retains terminal errors under the existing output budget                          | Small           | Very low       | admitted |
| 1C    | Tell the model to wait and re-inspect whenever delayed UI is absent after a click                                                                | Potentially avoids premature shortcut or target switching                         | Very small      | Low            | rejected |
| 2A    | Deduplicate shared policy from `browser_inspect` and `browser_scroll` schemas while retaining action-local hard guards                           | Smaller repeated tool definitions and more reliable scope selection               | Medium          | Medium         | admitted |
| 2B    | Compact `browser_inspect` model projection while retaining full audit output                                                                     | Fewer observation Tokens on document-heavy pages                                  | Medium          | Medium         | rejected |
| 2C    | Read-only semantic `browser_find` and ref-scoped inspection                                                                                      | Fewer full-tree reads and model rounds for targeted tasks                         | Medium          | Medium         | queued   |
| 2D    | Stabilize common browser schemas and validate dynamic refs in the executor                                                                       | Fewer schema changes and potentially better cache reuse                           | Medium          | Medium         | queued   |
| 2E    | Prioritize editable targets in the bounded interactive ref budget and disclose deferred image delivery after capture                             | Keeps dense-page editors actionable without broadening the page snapshot          | Very small      | Low            | admitted |
| 2F    | Classify fragment links as `same-page` from native DOM link semantics                                                                            | Gives generic navigation policy reliable table-of-contents evidence               | Small           | Low            | admitted |
| 3A    | Load installed Sandbox Skills through a hidden `skill_loader` system-prompt contributor only when Sandbox is reachable                           | Removes catalog/search coupling and avoids exposing unusable Sandbox capabilities | Small           | Low            | admitted |
| 3B    | Native deferred discovery for optional, non-browser tool families                                                                                | Lower large-tool-set prompt cost without hiding browser core tools                | Medium to large | Medium         | queued   |
| 3C    | Read-only programmatic orchestration for many independent network or history reads                                                               | Fewer model round trips on proven fan-out workloads                               | Large           | Medium to high | queued   |
| 3D    | Cross-conversation FTS retrieval with search-then-read IDs, excluding automatic memory                                                           | Reuse prior task evidence without replaying full conversations                    | Medium to large | Medium         | queued   |
| 3E    | Generic goal, completion-evidence, and no-progress state outside browser execution                                                               | Reduce drift and repeated calls in long Sandbox, network, or history tasks        | Medium          | Medium         | queued   |
| 4     | Content provenance boundaries, domain/action policy, and credential isolation                                                                    | Stronger resistance to page-originated instruction and unintended actions         | Large           | Medium to high | queued   |
| 4     | Explicit human takeover for CAPTCHA, 2FA, and approval-only states                                                                               | More recoverable blocked tasks                                                    | Large           | Medium         | queued   |

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
