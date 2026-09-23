# Task latency assessment — 2026-09-22

## Scope and conclusion

This is a read-only assessment of **ChatBrowserX executing user tasks**, not the elapsed time
Codex spends developing and validating changes. The earlier translation-renderer acceptance is
recorded separately in [the V20 validation report](translation-renderer-contracts-validation-20260921.md).
This assessment does not reopen that work, change production code, or claim an optimization gain.

Five existing, frozen sample contracts were selected before execution. Each ran once through the
canonical live runner, serially, with standalone environment verification first. **Three passed;
two failed and remain retained.** These observations identify bottlenecks and regression guards;
they are not a repeated baseline, a stability claim, or a before/after comparison.

For the three successful tasks, durable task execution totals 229.372 seconds: 183.501 seconds
in model-turn windows (**80.0%**), 45.554 seconds in tool-call windows, and 0.317 seconds elsewhere
inside the task. The priority is reducing unnecessary model round trips and examining lengthy
final-answer generation, not rewriting the scheduler or storage layer.

No current attempt reproduced an hours-long product task. Historical short/medium task results
and this bounded sample set cannot explain an unidentified hours-long task. Such a claim requires
that task's own trace. Earlier multi-hour development/retest work is a separate measurement domain.

## Frozen execution and sample selection

- Product label: `d503bbb9-v20`, a dirty-worktree frozen build identity, not a new Git commit.
- Frozen extension: `.runtime/translation-v20-isolated-GgK4FN/dist`.
- Integrity reference: `.runtime/renderer-contracts-20260921-AG6WCY/final-v20-candidate-sha256.txt`;
  216 snapshot hashes and 199 root production-source hashes match.
- Canonical dedicated Profile; no credential extraction, authentication copying, or concurrent load.
- Requests identify `gpt-5.6-terra`. Public settings read after the runs show `medium` reasoning,
  history limit 50, and no custom system prompt. Settings were not changed during these runs;
  the portable Provider trace does not independently record reasoning effort per request.
- No external message sending, calendar changes, document writes, or mutation authorization.
- Logs and numeric-only durable-event diagnosis: `.runtime/task-latency-20260922-gW0smq/`.
- Canonical attempt results remain only under each sample's `benchmark/` directory.

| Sample                          | Contract | Why it is useful                                                                                                       | Role in a future comparison                                                            |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `lark-doc-named-section`        | 15       | Bounded section, required facts and section-boundary guards; separates locating/reading from final synthesis           | Primary; at least 5 baseline + 5 candidate attempts                                    |
| `lark-doc-full-analysis`        | 17       | Full traversal, verified boundaries, factual output requirements; stresses virtualized reading and large context       | Primary; at least 5 baseline + 5 candidate attempts                                    |
| `lark-messenger-global-search`  | 1        | A narrow search/navigation outcome independently confirmed from the selected conversation                              | Primary; at least 5 baseline + 5 candidate attempts                                    |
| `lark-messenger-august-history` | 1        | Date-bounded virtualized history; tests incomplete loading and coverage rather than just producing a plausible summary | Correctness guard; current failure must remain visible                                 |
| `browser-network-evidence`      | 3        | Fixed safe GET workflow, exact tool counts, no sensitive headers/body or page edits                                    | Tool-availability guard and overhead control; not representative of every natural task |

The synthetic `example` result and translation target-readiness probes are not product-task
performance samples. Historical send/mail/calendar chains were inspected only for numeric
patterns, not executed without mutation scope. An old learning-page readiness failure is not
counted as model execution time. Do not silently replace difficult failed samples with easier ones.

## Current one-attempt observations

All durations below are seconds. `Task` is the durable run's `endedAt - startedAt`; `E2E` also
includes target opening/readiness, submission overhead, polling and report/evidence collection.

| Sample           | Acceptance                         |     E2E |   Task |  Model |  Tools | Other inside task | Model rounds / tool calls |
| ---------------- | ---------------------------------- | ------: | -----: | -----: | -----: | ----------------: | ------------------------: |
| Named section    | Pass                               |  64.317 | 61.140 | 55.544 |  5.525 |             0.071 |                     6 / 5 |
| Full document    | Pass                               | 100.392 | 96.657 | 66.669 | 29.885 |             0.103 |                     8 / 7 |
| Global search    | Pass                               |  84.745 | 71.575 | 61.288 | 10.144 |             0.143 |                   15 / 14 |
| Month history    | Fail: history unavailable          |  71.763 | 61.503 | 51.877 |  9.491 |             0.135 |                   14 / 13 |
| Network evidence | Fail: false unavailable-tool claim |  16.097 | 14.765 | 13.427 |  1.282 |             0.056 |                     4 / 3 |

All five have zero recorded Provider retries. Every attempt's Provider/evidence integrity checks
passed; failed acceptance is not hidden by the task engine's `completed` terminal status. Failed
tasks are excluded from the successful-task latency aggregate, **not** from the observed 3/5
acceptance result. Neither their short duration nor differences from old revisions are gains.

### Timing derivation and limitations

The one-off read-only diagnosis calls the existing `task.getSnapshot` through the canonical session.
It uses durable `tool.call` / `tool.result` timestamps and `model.turn` metrics, checks model/call
totals against all five immutable reports, and emits only timing/numeric metadata. It does not add
product telemetry, edit task history, or duplicate raw benchmark reports.

- Model time is the planner's Provider-stream window, including awaited inline stream persistence;
  it is **not** a pure server-inference measurement. See
  [model-turn-planner.ts](../src/agent/model/model-turn-planner.ts).
- Tool time is call-recorded to result-recorded: browser work, settling/observation and boundary
  overhead. It is not CPU time. See [task-executor.ts](../src/agent/task-executor.ts).
- `Other` is a residual, not independent fine-grained instrumentation. Small residuals do not prove
  that storage inside model/tool windows is free. Streaming persistence is already batched in
  [stream-persistence-buffer.ts](../src/agent/stream-persistence-buffer.ts).
- E2E minus Task is 1.3–13.2 seconds here. Do not blame that entire difference on product tools.
- Existing `firstTextMs` is relative to the first text-producing **model turn**, not necessarily
  user submission. For these samples the only text-producing turn is the final turn, so the small
  reported value must not be presented as end-to-end user time to first answer.
- Five one-attempt tasks cannot establish per-sample mean/P95, a population success rate, or speedup.

## Where the time goes

### 1. Final synthesis is a large share of document tasks

Named-section final generation takes **36.097 seconds**; earlier model turns take 19.447 seconds.
Full-document final generation takes **38.882 seconds**; earlier model turns take 27.787 seconds.
The final turns produce 1,877 and 2,025 output Tokens, respectively (including reported reasoning).
Reducing only browser waits cannot eliminate this part. Both contracts require substantive facts;
truncating the answer or omitting evidence to improve latency would be invalid.

### 2. Search spends more time asking the model what to do next than performing the actions

Global search requires 15 model turns, including four `browser_wait` calls and four inspections.
All wait calls together cost **4.971 seconds**; all inspections cost **0.426 seconds**. Its first
14 model turns cost **57.439 seconds**. Several waits return unchanged observations, but the later
delay does expose new content, so not every wait is redundant. The optimization opportunity is a
more reliable observation/ready-condition contract that avoids unnecessary _model_ decisions.

Do not equate a wait's `timeoutMs` with time actually spent waiting: the requested caps are
5,000 / 5,000 / 3,000 / 3,000 ms; observed waits are 593 / 608 / 621 / 3,149 ms.

### 3. Full traversal has real browser costs and growing context

Full-document reading observes 33 segments, with 29.885 seconds in tools and 196,980 model-visible
tool-output characters. Cumulative billed input is 378,510 Tokens across eight model calls, not
one request of that size. The last request has 88,343 input Tokens. No input cache hit is reported
for that attempt. Existing bounded multi-segment traversal and smaller model projections already
operate; they should not be proposed as entirely new functionality.

Common tool definitions still vary with scrollable refs and capability state in
[availability.ts](../src/tools/browser/availability.ts). Successful runs have 5 / 6 / 5 schema
variants. Stabilizing unnecessary schema variation is worth measuring, but low cache use alone
does not prove the cause, and Token savings do not guarantee latency savings. Dynamic constraints
also protect scope and traversal correctness.

### 4. Retries and scheduler/storage overhead are not demonstrated dominant causes here

No Provider retry occurred. The measured residual inside each successful task is 71–143 ms.
Do not add retry machinery, lower all timeouts, weaken durable boundaries, or rewrite the task
engine without evidence. These samples also do not justify parallel browser mutations.

## Failures retained and classified

### Month-history attempt: unresolved page readiness / observation boundary

The target conversation is confirmed, but ordinary and deep structured observations repeatedly
contain `Loading...`. The model makes five inspections, three waits and one scroll, then reports
that complete message history cannot be verified. This is a real unsuccessful task, not a pass
and not an optimization gain. The observations support an unavailable-history symptom, but do
not independently distinguish persistent site loading from an observation limitation. No
unproven external-site diagnosis or same-sample retry is used to erase the outcome.

The sample's standalone preflight checks the Messenger shell, not the eventual conversation's
complete history. A future fix should distinguish shell-ready from target-content-ready while
preserving bounded waiting and a truthful blocked result; it should not invent a summary.

### Network attempt: model/tool-discovery reliability failure

The model claims that `browser_network_stop` is unavailable and finishes without stop/list/get.
Provider request summaries show the tool **is present in requests 2, 3 and 4**. The start result
also explicitly says it is available. There is no HTTP failure or missing-tool dispatch evidence.
The observed defect is a false capability claim after dynamic tool disclosure; whether a stable
schema fixes it requires a controlled candidate, not assumption or another generic prompt hint.

### Execution-path mistake before full-document verification

One standalone verify invocation was accidentally launched using the isolated build tree's runner,
which has no sample catalog; it exited with missing `sample.json` before creating a task/run.
The failed log is preserved as `lark-doc-full-analysis-verify.log`. The corrected invocation uses
the root canonical runner and the same explicit frozen extension. This is one operator setup
failure, not a product benchmark attempt or discarded model failure.

## Recommended optimization order

These are recommendations, not admitted/implemented changes. No new dependency, site-specific
behavior, provider, background task or agent was introduced.

| Priority                | Candidate                                                                                                                                    | Expected value and scope                                                                                                                              | Cost / risk                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| First                   | Promote existing durable Task / model / tool timing into the standard analysis; distinguish end-to-end first text from turn-local first text | Avoid optimizing harness setup or attributing all residual time to browser work; reuse existing events                                                | Small; reporting/contract tests, no product behavior change required                                |
| High                    | Reduce redundant model decisions around action observations and readiness                                                                    | Search has 14 calls for a narrow outcome; check whether current observations already prove the next condition, with bounded recovery when they do not | Medium; requires real delayed-UI regressions and repeated search trials; no blanket wait removal    |
| High, correctness-first | Evaluate stable common tool contracts with executor-enforced dynamic validation                                                              | Addresses measured schema variation and the retained false-capability failure; may improve cache reuse                                                | Medium; preserve stale-ref/scope/boundary protections; extra exposed definitions may offset savings |
| Conditional             | Reduce unnecessary final-answer repetition while retaining every required fact                                                               | Two document tasks spend 36–39 seconds in final generation; often a larger lever than shaving local milliseconds                                      | Small implementation, meaningful quality risk; no length cap or weaker acceptance just for speed    |
| Later                   | Target large observations or duplicate traversal evidence, not generic truncation                                                            | Full-document input/output is large, but reading coverage is real; only remove demonstrated duplication                                               | Medium; completeness and exact reasoning continuation are hard gates                                |

Not recommended now: a scheduler rewrite; removing durability; generic longer/shorter waits;
parallelizing page edits; custom history compression; switching model/effort without a quality
comparison; adding a prompt cache key again without new evidence. The existing
[optimization ledger](OPTIMIZATION.md) records rejected generic wait hints and cache-key trials.

For implementation, freeze one candidate at a time, first resolve or explicitly retain the two
guardrail failures, and then run affected critical samples with at least five baseline and five
candidate attempts under identical settings. Interleave where Provider/site variability matters.
Report success first, then mean/P95, rounds, tokens and time; follow the ledger's correctness gate
and attributable-benefit thresholds. No large generic rewrite is supported by this assessment.

## Evidence index and verification

| Sample                | Immutable report                                                                        |
| --------------------- | --------------------------------------------------------------------------------------- |
| Named section         | [01.json](samples/lark-doc-named-section/benchmark/20260922T111558.322Z/01.json)        |
| Full document         | [01.json](samples/lark-doc-full-analysis/benchmark/20260922T112135.713Z/01.json)        |
| Global search         | [01.json](samples/lark-messenger-global-search/benchmark/20260922T112411.918Z/01.json)  |
| Month history, failed | [01.json](samples/lark-messenger-august-history/benchmark/20260922T112619.592Z/01.json) |
| Network, failed       | [01.json](samples/browser-network-evidence/benchmark/20260922T112920.491Z/01.json)      |

Execution used the existing root `tsx e2e/runner/verify.ts <sample>` and
`tsx e2e/runner/benchmark.ts <sample> 1` with the paired external-build path/revision environment
variables; no root build was run. Doctor: 6/6. All five standalone preflights pass; live task
acceptance remains 3/5. Catalog: 39 valid contracts, not 39 live passes. The numeric-only durable
diagnosis matches all five reports. Report formatting, diagnostic syntax and source/build hash
integrity are checked separately. Production code and the shared runner are unchanged by this
assessment, so no new production/browser gate pass is claimed. Root `dist` and inherited worktree
changes are preserved; no commit or push was made.
