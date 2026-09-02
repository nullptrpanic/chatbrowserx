# ChatBrowserX E2E Sample and Result Specification

This is the canonical format definition. It describes the portable sample contract and one
immutable report per attempt; it does not describe a particular sample.

## Storage and Transport

```text
e2e/samples/<sample-id>/
├── sample.json
└── benchmark/                       # Created by the first evaluation run
    └── <UTC-batch-timestamp>/
        ├── 01.json
        ├── ...
        └── report.json
```

The directory name and sample.json id must be identical lowercase kebab-case values. Do not add a
per-sample README or code-owned scenario registry.

A sample can be created, generated, or delivered through any controlled channel outside Git.
Transfer `sample.json` for a new history, or the complete sample directory to preserve history.
`benchmark/` is created by the first run and must not be kept as an empty placeholder. One command
writes all of its ordered attempts below one timestamped `benchmark/` directory; omitting its run
count produces one attempt. Never overwrite an attempt report with different bytes. After creation
or import, run `npm run e2e:catalog:validate`, then follow `RUNBOOK.md`.

Real samples remain outside Git. The repository tracks only the public synthetic
[`samples/example/`](samples/example/) fixture so a fresh checkout always contains one complete,
valid sample, attempt, and batch-summary reference.

## Sample Schema Version 4

| Field           | Type             | Meaning                                                   |
| --------------- | ---------------- | --------------------------------------------------------- |
| schemaVersion   | integer          | Exactly 4.                                                |
| id              | string           | Stable ID matching the directory name.                    |
| contractVersion | positive integer | Acceptance version separating incomparable histories.     |
| description     | string           | Concise English objective.                                |
| requiredRuns    | positive integer | Predeclared comparable attempts per revision.             |
| resources       | object           | Cross-process remote-resource isolation keys.             |
| target          | object           | Initial page, origin, and readiness timeout.              |
| environment     | object           | Setup instructions and machine-readable readiness checks. |
| input           | object           | Exact user request sent to a fresh WorkSession.           |
| execution       | object           | Runtime budget and tool boundary.                         |
| sideEffects     | object           | Coarse read-only or page-mutation authorization.          |
| evaluation      | object           | Deterministic evaluation method and acceptance policy.    |

Human metadata and setup instructions use English. Exact input and literal evidence may use the
target page's language.

### resources

`resources.exclusive` is a required array of unique lowercase resource keys. Use the same key for
samples that cannot safely overlap, such as one chat, mailbox, calendar, editor state, or exam
attempt; use an empty array when the sample has no shared mutable resource. The runner also adds an
implicit sample key, caps live execution at five workers, and acquires all keys atomically before
opening the browser. Keys coordinate execution only and must not contain credentials.

### target

| Field              | Type             | Meaning                                         |
| ------------------ | ---------------- | ----------------------------------------------- |
| url                | absolute URL     | Initial page opened by the runner.              |
| expectedOrigin     | origin           | Must exactly equal the origin derived from url. |
| readinessTimeoutMs | positive integer | Maximum extension and target readiness time.    |

### environment

| Field                   | Type            | Meaning                                                   |
| ----------------------- | --------------- | --------------------------------------------------------- |
| targetSetupMode         | enum            | none or interactive.                                      |
| targetSetupInstructions | string array    | Non-secret human steps; non-empty for interactive mode.   |
| readinessChecks         | non-empty array | Conditions enforced by setup, verify, and live execution. |

Supported readiness checks:

| kind               | Value  | Rule                                                              |
| ------------------ | ------ | ----------------------------------------------------------------- |
| url_includes       | value  | URL contains the literal.                                         |
| url_excludes       | value  | URL excludes the literal.                                         |
| page_text_includes | value  | Normalized visible text contains the literal, case-insensitively. |
| page_text_excludes | value  | Normalized visible text excludes the literal, case-insensitively. |
| page_text_any      | values | Visible text contains at least one listed literal.                |

Checks prove a usable target state, not only a generic shell. They must not contain credentials,
cookies, secret query parameters, or private excerpts. Visible text is used only for bounded
matching and is not returned or persisted by verification.

### input and execution

| Field                    | Type                   | Meaning                                                        |
| ------------------------ | ---------------------- | -------------------------------------------------------------- |
| input.text               | non-empty string       | Complete task; each {{RUN_ID}} becomes the attempt run ID.     |
| execution.taskTimeoutMs  | positive integer       | Attempt wall-clock budget.                                     |
| execution.maxToolCalls   | positive integer       | Runaway ceiling, not an efficiency target.                     |
| execution.requiredTools  | non-empty string array | Tools that must appear unless exact counts supersede presence. |
| execution.forbiddenTools | string array           | Tools that must not appear; may be empty.                      |

A tool cannot be both required and forbidden. The input must be self-contained and must not depend
on a hidden prompt.

### sideEffects and evaluation

| Field             | Type   | Meaning                               |
| ----------------- | ------ | ------------------------------------- |
| sideEffects.mode  | enum   | read_only or page_state_mutation.     |
| evaluation.method | enum   | Exactly deterministic.                |
| evaluation.policy | object | Machine-readable acceptance contract. |

page_state_mutation opens only the mutation execution category and additionally requires
CHATBROWSERX_LIVE_ALLOW_MUTATION=1. The exact task is still bounded by input, execution policy,
acceptance checks, and product safety rules.

### evaluation.policy

| Field                                | Type                   | Required | Meaning                                                               |
| ------------------------------------ | ---------------------- | -------- | --------------------------------------------------------------------- |
| forbidScreenshotInspect              | boolean                | yes      | Fail screenshot-based inspection when true.                           |
| forbidSubmittedType                  | boolean                | yes      | Fail submitted typing operations when true.                           |
| finalTextIncludes                    | non-empty string array | yes      | Every normalized literal must occur in final output.                  |
| minFinalTextLength                   | non-negative integer   | no       | Optional coarse minimum when explicit output checks are insufficient. |
| expectedSubmittedTypeCount           | non-negative integer   | no       | Exact submitted typing count.                                         |
| expectedToolCounts                   | integer map            | no       | Exact count for every named tool.                                     |
| requiredVerifiedTools                | non-empty string array | no       | Every result from each named tool must be verified and successful.    |
| maxScrollSegmentsPerCall             | positive integer       | no       | Traversal segments allowed before model reassessment.                 |
| maxTraversalSegments                 | positive integer       | no       | Maximum browser-reported `data.segments` across all scroll calls.     |
| stopScrollingAfterActiveElementNames | string array           | no       | Reject later scrolling after a named section becomes active.          |
| requireVerticalBoundaryCoverage      | boolean                | no       | Require ordered top-before-bottom evidence.                           |
| maxAttachmentCount                   | non-negative integer   | no       | Maximum durable image references in tool results.                     |
| requiredTypedTextIncludes            | string array           | no       | Literals required in captured typing arguments.                       |
| allowedKeypresses                    | non-empty string array | no       | Exact navigation key sequences allowed for `browser_keypress`.        |
| requiredToolResultIncludes           | string array           | no       | Literals required in at least one complete durable tool result.       |
| requiredToolOutputIncludes           | string array           | no       | Literals required as post-submit static page text.                    |
| requiredMutationReadbacks            | object array           | no       | Structural values required after each named commit button.            |
| finalTextIncludesAny                 | array of string arrays | no       | Require one alternative from every inner group.                       |
| requireFreshProviderContext          | boolean                | no       | Require only the active request in the first Provider context.        |
| finalTextExcludes                    | string array           | no       | Any normalized matching literal fails output.                         |
| minimumMarkdownTableRows             | positive integer       | no       | Minimum Markdown data-row count.                                      |

Each `requiredMutationReadbacks` item contains an exact accessible button `actionName` and a
non-empty `includes` array. Draft/editor values and evidence observed before the named action do
not satisfy it. Every value must be structurally visible after that action and before the next
submit-like action; named non-text evidence such as a content image is allowed.

## Complete Sample

The tracked [`samples/example/sample.json`](samples/example/sample.json) is the complete sample
example for this schema. It uses a public target, needs no target authentication, and contains no
private or task-specific data. Copy its structure, not its identity or benchmark history, when
creating another sample.

## Evaluation Attempt Report Schema Version 4

All fields below are required. failure is null for a pass and an object for a failure.

| Field                                             | Meaning                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| schemaVersion                                     | Exactly 4.                                                                                          |
| sampleId / runId                                  | Sample identity and unique attempt identity.                                                        |
| batch.collection                                  | Always `benchmark`.                                                                                 |
| batch.id / startedAt                              | Batch directory name and its ISO UTC creation time.                                                 |
| batch.requestedRuns / attempt                     | Declared batch size and this report's one-based attempt number.                                     |
| productRevision                                   | Product revision or explicit isolated-build label.                                                  |
| scenarioContractVersion                           | Contract version used by the attempt.                                                               |
| startedAt / endedAt / elapsedMs                   | UTC boundaries and wall-clock duration.                                                             |
| terminalStatus / success                          | Product terminal state and final evaluation decision.                                               |
| input.text / output.text                          | Materialized request and final output; failed output may be empty.                                  |
| tokenUsage.inputTokens                            | Provider-reported input tokens.                                                                     |
| tokenUsage.outputTokens                           | Provider-reported output tokens.                                                                    |
| tokenUsage.totalTokens                            | Provider-reported total tokens.                                                                     |
| tokenUsage.cachedInputTokens                      | Cached input tokens.                                                                                |
| tokenUsage.cacheWriteInputTokens                  | Cache-write input tokens reported by the Provider.                                                  |
| tokenUsage.reasoningOutputTokens                  | Reasoning output tokens.                                                                            |
| execution.modelElapsedMs / modelRounds            | Cumulative model-call time and logical model-turn count for this attempt.                           |
| execution.firstEventMs / firstTextMs              | First turn event latency and first text-producing turn latency; zero when unavailable.              |
| execution.providerRetries / providerRetryCounts   | Total retries and counts by persisted reason.                                                       |
| execution.toolCalls / toolCounts                  | Total Tool Calls and counts by tool name.                                                           |
| execution.fullInteractiveObservations             | Full interactive browser observations.                                                              |
| execution.providerRequests / compactionRequests   | Actual Provider-call count, including retries, and unsupported compact calls for this attempt.      |
| execution.traversalSegments / screenshotFallbacks | Browser-reported traversal segments and screenshot fallback counts.                                 |
| execution.screenshotFallbackReasons               | Screenshot fallback counts grouped by reason.                                                       |
| execution.staleRefs / stateMismatches             | Stale semantic references and post-action mismatches.                                               |
| execution.repeatedFingerprints / noProgressBlocks | Repeated actions and no-progress blocks.                                                            |
| execution.verifiedMutations / ambiguousMutations  | Verified and ambiguous mutation counts.                                                             |
| execution.auditOutputCharacters                   | Tool-output characters retained for audit.                                                          |
| execution.modelOutputCharacters                   | Tool-output characters exposed to the model.                                                        |
| execution.modelOutputReductionCharacters          | Audit characters minus model-visible characters.                                                    |
| execution.toolDefinitionCharactersTotal / Max     | Repeated tool-contract size across Provider requests and its per-request maximum.                   |
| execution.toolDefinitionSchemaChanges / Variants  | Ordered tool-contract changes and distinct contract fingerprints.                                   |
| execution.enabledToolsets                         | Optional toolsets exposed during the attempt.                                                       |
| execution.skillCatalogDisclosureCount             | Skill catalog entries exposed to the model.                                                         |
| execution.exactReads                              | Exact historical result reads.                                                                      |
| execution.auditOutputCharactersByTool             | Audit-output characters grouped by tool name.                                                       |
| execution.modelOutputCharactersByTool             | Model-visible output characters grouped by tool name.                                               |
| acceptance.passed / acceptance.checks             | Overall machine decision and each named check.                                                      |
| failure.taskError / harnessError / failedChecks   | Product task error, harness error, and failed checks; evidence defects use `E2E_EVIDENCE_MISMATCH`. |
| evidence.taskId / conversationId                  | Opaque execution identifiers, or `null` when preflight failed before creation.                      |
| evidence.toolResults                              | Complete bounded and redacted tool arguments, results, and attachment references.                   |
| evidence.providerTrace                            | Bounded structural Provider request and response evidence.                                          |

The directory identifies the batch and filenames identify attempt order:

```text
benchmark/20260827T130000.000Z/01.json
benchmark/20260827T130000.000Z/02.json
```

Every attempt report contains its `runId`; run IDs are never directory names. Attempt files are
contiguous from `01.json`, use exclusive creation, and share collection, batch, contract, revision,
and requested-run metadata. A stopped benchmark may contain fewer files than `requestedRuns`, but
it cannot contain a gap. Each attempt report is the complete portable comparison and diagnostic
record, so no second raw-report file or `sourceReport` pointer exists. Flat files and older schemas
are rejected; the harness has one current layout and one current attempt-report contract.

The tracked
[`samples/example/benchmark/20260101T000000.000Z/01.json`](samples/example/benchmark/20260101T000000.000Z/01.json)
is a complete attempt-report example. Its IDs, revision, timings, Token counts, and evidence are
synthetic format fixtures, not product measurements.

## Batch Summary Schema Version 1

Every batch directory also contains one derived `report.json`. It is atomically replaced after each
completed attempt and contains aggregate values only:

| Field                           | Meaning                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| schemaVersion                   | Exactly 1.                                                             |
| sampleId / collection / batchId | Identity copied from the batch attempts and directory.                 |
| requestedRuns / completedRuns   | Declared count and number of persisted attempts.                       |
| successfulRuns / failedRuns     | Counts across all completed attempts, including harness failures.      |
| totalProviderRequests           | Sum of actual Provider requests across all completed attempts.         |
| totalProviderRequestElapsedMs   | Sum of `execution.modelElapsedMs` across all completed attempts.       |
| averageTotalTokens              | Mean `tokenUsage.totalTokens` across all completed attempts.           |
| averageElapsedMs                | Mean wall-clock `elapsedMs` across all completed attempts.             |
| averageToolCalls                | Mean `execution.toolCalls` across all completed attempts.              |
| averageProviderRequestElapsedMs | Sum of model elapsed time divided by the total Provider request count. |

All averages include successful and failed attempts. When there are no Provider requests,
`averageProviderRequestElapsedMs` is zero. Values are rounded to at most six decimal places. The
summary contains no run IDs, input, output, evidence, or tool detail. Attempt files remain the
immutable factual source; catalog validation rejects a missing summary or one that cannot be
recomputed exactly from those attempts.

The tracked
[`samples/example/benchmark/20260101T000000.000Z/report.json`](samples/example/benchmark/20260101T000000.000Z/report.json)
is the batch-summary example and is exactly derivable from the adjacent `01.json`.
