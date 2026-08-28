# ChatBrowserX E2E Sample and Result Specification

This is the canonical format definition. It describes the portable sample contract and one
immutable result per attempt; it does not describe a particular sample.

## Storage and Transport

```text
e2e/samples/<sample-id>/
├── sample.json
└── results/
    └── <UTC-timestamp>__<run-id>.json
```

The directory name and sample.json id must be identical lowercase kebab-case values. Do not add a
per-sample README or code-owned scenario registry.

A sample can be created, generated, or delivered through any controlled channel outside Git.
Transfer sample.json plus an empty results directory for a new history, or the complete sample
directory to preserve history. Never overwrite a result with different bytes. After creation or
import, run npm run e2e:catalog:validate, then follow RUNBOOK.md for environment setup and execution.

## Sample Schema Version 3

| Field           | Type             | Meaning                                                   |
| --------------- | ---------------- | --------------------------------------------------------- |
| schemaVersion   | integer          | Exactly 3.                                                |
| id              | string           | Stable ID matching the directory name.                    |
| contractVersion | positive integer | Acceptance version separating incomparable histories.     |
| description     | string           | Concise English objective.                                |
| requiredRuns    | positive integer | Predeclared comparable attempts per revision.             |
| target          | object           | Initial page, origin, and readiness timeout.              |
| environment     | object           | Setup instructions and machine-readable readiness checks. |
| input           | object           | Exact user request sent to a fresh WorkSession.           |
| execution       | object           | Runtime budget and tool boundary.                         |
| sideEffects     | object           | Coarse read-only or page-mutation authorization.          |
| evaluation      | object           | Deterministic evaluation method and acceptance policy.    |

Human metadata and setup instructions use English. Exact input and literal evidence may use the
target page's language.

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

| Field                                | Type                   | Required | Meaning                                                            |
| ------------------------------------ | ---------------------- | -------- | ------------------------------------------------------------------ |
| forbidScreenshotInspect              | boolean                | yes      | Fail screenshot-based inspection when true.                        |
| forbidSubmittedType                  | boolean                | yes      | Fail submitted typing operations when true.                        |
| finalTextIncludes                    | non-empty string array | yes      | Every normalized literal must occur in final output.               |
| minFinalTextLength                   | non-negative integer   | yes      | Minimum final-output character count.                              |
| expectedSubmittedTypeCount           | non-negative integer   | no       | Exact submitted typing count.                                      |
| expectedToolCounts                   | integer map            | no       | Exact count for every named tool.                                  |
| requiredVerifiedTools                | non-empty string array | no       | Every result from each named tool must be verified and successful. |
| maxScrollSegmentsPerCall             | positive integer       | no       | Traversal segments allowed before model reassessment.              |
| stopScrollingAfterActiveElementNames | string array           | no       | Reject later scrolling after a named section becomes active.       |
| requireVerticalBoundaryCoverage      | boolean                | no       | Require ordered top-before-bottom evidence.                        |
| maxAttachmentCount                   | non-negative integer   | no       | Maximum durable image references in tool results.                  |
| requiredTypedTextIncludes            | string array           | no       | Literals required in captured typing arguments.                    |
| requiredToolOutputIncludes           | string array           | no       | Literals required in captured tool output.                         |
| finalTextIncludesAny                 | array of string arrays | no       | Require one alternative from every inner group.                    |
| requireFreshProviderContext          | boolean                | no       | Require only the active request in the first Provider context.     |
| finalTextExcludes                    | string array           | no       | Any normalized matching literal fails output.                      |
| minimumMarkdownTableRows             | positive integer       | no       | Minimum Markdown data-row count.                                   |

## Complete Sample

```json
{
  "schemaVersion": 3,
  "id": "example-read",
  "contractVersion": 1,
  "description": "Reads one example page without changing remote data.",
  "requiredRuns": 3,
  "target": {
    "url": "https://example.com/",
    "expectedOrigin": "https://example.com",
    "readinessTimeoutMs": 30000
  },
  "environment": {
    "targetSetupMode": "interactive",
    "targetSetupInstructions": [
      "Sign in with an evaluation account that can read the example workspace."
    ],
    "readinessChecks": [
      { "kind": "url_excludes", "value": "/login" },
      { "kind": "page_text_includes", "value": "Example Domain" }
    ]
  },
  "input": {
    "text": "Read the visible page and report its heading. Do not modify the page."
  },
  "execution": {
    "taskTimeoutMs": 120000,
    "maxToolCalls": 10,
    "requiredTools": ["browser_inspect"],
    "forbiddenTools": ["browser_type", "browser_click_point"]
  },
  "sideEffects": {
    "mode": "read_only"
  },
  "evaluation": {
    "method": "deterministic",
    "policy": {
      "forbidScreenshotInspect": true,
      "forbidSubmittedType": true,
      "finalTextIncludes": ["Example Domain"],
      "finalTextExcludes": ["unable to verify"],
      "minFinalTextLength": 20
    }
  }
}
```

## Standard Result Schema Version 2

All fields below are required. failure is null for a pass and an object for a failure.

| Field                                             | Meaning                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| schemaVersion                                     | Exactly 2.                                                                                             |
| sampleId / runId                                  | Sample identity and unique attempt identity.                                                           |
| productRevision                                   | Product revision or explicit isolated-build label.                                                     |
| scenarioContractVersion                           | Contract version used by the attempt.                                                                  |
| startedAt / endedAt / elapsedMs                   | UTC boundaries and wall-clock duration.                                                                |
| terminalStatus / success                          | Product terminal state and final evaluation decision.                                                  |
| input.text / output.text                          | Materialized request and final output; failed output may be empty.                                     |
| tokenUsage.inputTokens                            | Provider-reported input tokens.                                                                        |
| tokenUsage.outputTokens                           | Provider-reported output tokens.                                                                       |
| tokenUsage.totalTokens                            | Provider-reported total tokens.                                                                        |
| tokenUsage.cachedInputTokens                      | Cached input tokens.                                                                                   |
| tokenUsage.reasoningOutputTokens                  | Reasoning output tokens.                                                                               |
| execution.modelElapsedMs / modelRounds            | Cumulative model time and round count.                                                                 |
| execution.providerRetries / providerRetryCounts   | Total retries and counts by persisted reason.                                                          |
| execution.toolCalls / toolCounts                  | Total Tool Calls and counts by tool name.                                                              |
| execution.providerRequests / compactionRequests   | Provider requests and unsupported compact calls.                                                       |
| execution.traversalSegments / screenshotFallbacks | Structured traversal and screenshot fallback counts.                                                   |
| execution.staleRefs / stateMismatches             | Stale semantic references and post-action mismatches.                                                  |
| execution.repeatedFingerprints / noProgressBlocks | Repeated actions and no-progress blocks.                                                               |
| execution.verifiedMutations / ambiguousMutations  | Verified and ambiguous mutation counts.                                                                |
| execution.auditOutputCharacters                   | Tool-output characters retained for audit.                                                             |
| execution.modelOutputCharacters                   | Tool-output characters exposed to the model.                                                           |
| execution.modelOutputReductionCharacters          | Audit characters minus model-visible characters.                                                       |
| acceptance.passed / acceptance.checks             | Overall machine decision and each named check.                                                         |
| failure.harnessError / failedChecks               | Sanitized harness error and failed check facts; evidence protocol defects use `E2E_EVIDENCE_MISMATCH`. |
| sourceReport                                      | Relative pointer to the machine-local raw report.                                                      |

The filename is derived from startedAt and runId, for example:

```text
20260827T123346.514Z__live_1f11acdc-79f6-4fc8-bbd8-65aa5a12f4cd.json
```

Writers use exclusive creation. Result history is sufficient for portable comparison;
`sourceReport` may point to diagnostics that were not transported. The catalog indexes only schema
version 2; other formats are outside the current contract.
