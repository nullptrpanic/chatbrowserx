# ChatBrowserX Project Instructions

## Live Validation Discipline

These rules apply to authenticated browser validation, live E2E scenarios, provider integration
checks, and other tests that operate the real ChatBrowserX extension against a live page.

### Define Success Before Running

- Define the expected user-visible result, allowed side effects, required evidence, and failure
  conditions before starting a live validation run.
- A task reaching `completed` is not sufficient evidence that the behavior is correct.
- Do not loosen an acceptance rule after seeing a result merely to make the run pass.

### Inspect the Complete Evidence Chain

- Evaluate the final task output for correctness, completeness, relevance, and consistency with the
  page state.
- Inspect the task status, errors, execution details, tool calls, tool results, generated reports,
  and relevant logs.
- In this document, "network capture" means capturing the ChatBrowserX extension's own network
  traffic, such as model/provider API requests and responses sent by the extension background or
  service-worker runtime. It does not mean capturing the target web page's network traffic.
- Capture target-page network traffic only when the user explicitly requests page-traffic analysis
  or when page traffic is itself part of the stated acceptance criteria. Do not substitute page
  traffic for extension traffic when diagnosing the extension's task execution or provider chain.
- When extension network behavior is relevant to the failure or success criteria, capture and
  inspect the necessary requests at the extension boundary. Use bounded, sanitized evidence and
  the existing safe capture mechanisms.
- For Responses API validations, inspect a sanitized structural summary of the outbound `input` at
  the extension boundary. Do not persist the raw prompt, message text, image data, tool output,
  headers, cookies, or credentials merely to validate request construction.
- Verify that Responses API input items remain in chronological order; the active user request and
  any in-task supplement appear exactly once at their intended boundary; completed conversation
  messages are neither omitted nor duplicated; and cancelled, paused, retried, or resumed work does
  not reorder newer user input behind unrelated earlier work.
- Verify that every `function_call` has exactly one matching `function_call_output` with the same
  `call_id`, no output is orphaned, call IDs are not reused within the active work session, and
  context compaction preserves all call/output pairs that remain in the request.
- Because this integration manages Responses API context manually with `store: false`, verify that
  every model output item needed for continuation is preserved and replayed, not only reconstructed
  function calls. In particular, retain assistant message items emitted alongside tool calls and
  the provider-returned encrypted reasoning items required for stateless reasoning continuity.
  A request can be schema-valid while still being semantically incomplete if these items are
  missing.
- Verify the live provider response as well as the next request: encrypted reasoning content must be
  requested or otherwise returned by the fixed endpoint, parsed without exposing raw reasoning,
  durably associated with its model turn, and replayed exactly once before the corresponding tool
  output or subsequent user input. Never log or display encrypted reasoning payloads.
- Verify the fixed provider contract (`store: false` for the ChatGPT Codex endpoint, no unsupported
  state-linking fields, one declared tool definition per callable name, and a tool choice that names
  an actually declared tool). Treat any structural mismatch as a material validation failure.
- Never record, print, persist, or include access tokens, cookies, authorization headers, passwords,
  or other credentials in validation output or reports.
- Distinguish a product defect from a harness defect, provider failure, authentication problem, or
  external-site change instead of treating every failure as the same class of issue.

### Stop on the First Material Problem

- Stop the current live validation as soon as a material problem is observed. Examples include an
  incorrect or unsupported final answer, repeated action or refresh loops, unexpected tool
  fallbacks, provider or protocol errors, unsafe side effects, remote mutation during a read-only
  scenario, failed acceptance checks, or evidence that makes the result untrustworthy.
- If the task is still running, cancel only that task when it is safe to do so. Do not continue with
  later live scenarios while the problem remains unresolved.
- Do not automatically retry until a run happens to pass. Preserve the failing task, report, logs,
  and sanitized extension-network evidence so the first failure remains diagnosable.
- Determine and report the root cause, or the exact unresolved blocker, before resuming validation.
  After a fix, start a new explicit run and compare it with the retained failure evidence.

### Report Honestly

- Report which evidence was inspected, why the run passed or stopped, and any validation limitation.
- Do not claim a success rate from a single passing run.
- Do not hide an earlier failure behind a later successful retry; report both and explain what
  changed between them.
