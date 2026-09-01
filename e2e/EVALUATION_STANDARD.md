# ChatBrowserX E2E Evaluation Standard

This document defines how an evaluation is executed, judged, preserved, and compared. RUNBOOK.md
owns environment reconstruction and commands. SAMPLE_SPEC.md owns data formats.

## Contract and Units

- A sample fixes one target, exact input, execution budget, side-effect mode, and deterministic
  acceptance policy.
- An attempt starts one fresh WorkSession and ends with one immutable report.
- A batch is one command's ordered attempts for one product revision and one timestamp directory.
- A batch summary is a replaceable aggregate derived from its immutable attempt reports.
- When created, `results/` stores ordinary runs and `benchmark/` stores formal comparable batches;
  do not retain empty placeholder directories.

Freeze `sample.json` before the first attempt. Increment `contractVersion` when task, input,
side-effect, or acceptance semantics change. Never loosen a check after observing a result.

`sideEffects.mode` authorizes only a coarse category; input, tool restrictions, policy, and product
safety still bound the action.

## Standard Flow

Rebuild and verify the environment with `RUNBOOK.md`, then:

1. Run one explicit attempt.
2. Inspect the complete evidence chain.
3. Stop and classify the first material failure.
4. Only after the first attempt passes, run the predeclared batch.
5. Compare immutable attempt facts; never cherry-pick retries.

Once a run ID exists, persist exactly one immutable report for every terminal outcome. A fix creates
a new attempt; it never replaces the old report. Atomically refresh `report.json` after each
persisted attempt. The summary is convenient output, not a substitute for attempt evidence.

## Evidence and Pass Decision

Inspect the contract-relevant evidence:

- Final user-visible output, terminal status, harness error, and every acceptance check.
- Tool sequence, arguments, results, total calls, and per-tool counts.
- Independent page readback for a declared mutation.
- Execution metrics, detailed bounded tool evidence, and relevant extension logs.
- Sanitized Provider request and response structure when Provider behavior is material.

An attempt passes only when all applicable facts agree:

- terminalStatus is completed, harnessError is null, and acceptance.passed is true.
- Inline environment verification passed before submission.
- Output, tool, count, traversal, attachment, and Provider checks satisfy policy.
- Required tools are present, forbidden tools are absent, and required verified tools succeeded.
- Read-only samples made no remote mutation; declared mutations have verified readback.
- A declared mutation checkpoint is satisfied only by structural evidence observed after its
  named commit action; draft state and model claims are not completion evidence.
- Provider continuation is complete and compactionRequests is zero.
- No unexplained fallback, stale reference, mismatch, loop, unsafe traversal, or ambiguous mutation
  makes the evidence untrustworthy.

The factual source for model telemetry and tools is the terminal `TaskSnapshot`: numeric
`model.turn` events and permanent `toolResults`. Panel details are only a UI consistency check.
Missing or contradictory event/result/Provider evidence is `E2E_EVIDENCE_MISMATCH`, not zero usage.
Product task errors and timeouts remain comparable failed outcomes. Environment, harness, and
evidence errors invalidate product comparison and are stored separately as `harnessError`.

Completed alone is not a pass. If the target changed or evidence is insufficient, retain a failed
attempt rather than weakening the contract.

For Responses API evidence, verify chronological input order, one active request, unique complete
function-call/output pairs, and continuation items. The contract is `/responses` with `store:false`,
no `/responses/compact`, no unsupported state-linking fields, one definition per callable tool, and
a declared tool choice. Replay encrypted reasoning exactly once for its model turn; never log it.

## Failure Handling

Preserve the report, logs, and bounded sanitized Provider evidence. Classify the first material
failure before another attempt:

| Classification         | Closure                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Product defect         | Make the smallest product fix justified by reproducible evidence, then rerun the frozen sample. |
| Harness defect         | Fix only `e2e/`, prove evidence capture with deterministic tests, then rerun.                   |
| Provider failure       | Preserve the response structure and retry only under the declared retry policy.                 |
| Authentication problem | Rebuild supported authentication and pass standalone verification.                              |
| External-site change   | Update environment or increment the sample contract when semantics changed.                     |
| Unresolved blocker     | Preserve it and report the limitation; do not manufacture a pass.                               |

E2E goals alone never justify a product change, weaker checks, cherry-picked retries, or discarded
failures.

## Comparable Results

Compare only attempts with:

- sample ID and contractVersion;
- one explicit product revision per side;
- identical model settings and acceptance policy;
- profile initialization rule and relevant authenticated state;
- predeclared attempt count and first-attempt semantics.

Use:

```bash
npm run --silent e2e:benchmark:compare -- <sample-id> <left-revision> <right-revision> [runs]
```

The command reads only `benchmark/` and selects the earliest N current-contract reports per
revision; N defaults to
`requiredRuns`. It retains observed success rates but emits `null` deltas when evidence integrity
prevents comparison. Deltas are right minus left. Report success rate, mean and P95 duration,
cache read/write Tokens, first-event/first-text latency, rounds, Provider requests/retries, total
and per-tool calls, tool-contract size and changes, traversal/fallback metrics, mutation
verification, per-tool output reduction, failures, and limitations. One pass is not a stability
claim.

## Repository Gates

Run narrow checks first. Before completing a harness or production change, run:

```bash
npm run format:check
npm run lint
npm run test:run
npm run test:e2e
npm run audit:bundle
npm run check:sandbox
npm run e2e:catalog:validate
```

`test:e2e` includes typecheck, build, and Playwright browser tests. Run `check:codex` only when the
shell already has its token; never extract credentials from the Profile. The environment doctor is
part of reconstruction, not a code-quality gate.
