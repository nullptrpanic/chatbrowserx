# ChatBrowserX Project Instructions

## Local Iteration and Verification

Default to short, scoped iterations: inspect the relevant implementation and tests, make one
focused change, run the narrowest meaningful checks, review the diff, and deliver. Reuse existing
patterns and tests. Routine edits do not need a separate plan document, a new benchmark harness,
or broad repository exploration.

Choose validation by the affected behavior and risk, not by line count:

- Documentation-only changes: check formatting of the edited files and `git diff --check`.
- Bounded local code changes: run the applicable formatting/static checks and affected tests.
- Changes to concurrency, cancellation, persistence, authentication, or shared contracts: add the
  relevant integration regression or affected subsystem suite needed to cover that risk.
- Browser behavior changes: run the affected browser regression; use representative smoke cases
  when shared browser behavior is affected. Sandbox/backend-only changes do not automatically
  require browser E2E. Real-site replay is for site-dependent behavior or explicitly requested
  live verification.

Once the relevant checks pass and no concrete concern remains, stop validating and deliver.
Broaden or repeat checks only when a new change, failure, unresolved risk, or explicit requirement
justifies it. A later edit invalidates checks for the affected behavior, not every earlier result.
Reuse a built candidate only when its source, assets, dependencies, and build configuration are
unchanged.

Full repository or browser suites are reserved for an explicit user request, an applicable
CI/release requirement, or broad impact that narrower checks cannot cover. State the concrete
reason before expanding validation, then proceed within the already authorized scope; routine
check selection does not need another approval. This section owns local validation scope; E2E
documents provide execution procedures and evidence requirements, not a blanket full-suite gate
for every edit.

For small optimizations, assess benefit versus implementation and verification cost first. Use
existing measurements or a minimal comparison when needed to resolve uncertainty or substantiate
a quantitative claim. Do not build new measurement infrastructure merely to attach a percentage
to an obvious local improvement, and do not claim measured gains without evidence.

Aim for a few-minute cycle for routine edits. If the task grows, explain the concrete blocker or
risk and use the least costly sufficient next step; elapsed time never substitutes for correctness.
Report the change, checks actually run, and material limitations concisely. A targeted pass must
not be described as a full-suite pass.

## E2E Evaluation

All reusable E2E implementation, tests, configuration, and documentation belong under the root
`e2e/` directory. Before creating a sample, changing the E2E harness, or running a live evaluation,
read and follow `e2e/AGENTS.md` and `e2e/RUNBOOK.md`. The runbook's doctor, interactive setup,
standalone verification, and live-run sequence is the canonical environment reconstruction path;
do not create a sample-specific authentication or execution path.

## Optimization Failures

When an optimization fails validation, preserve the evidence, identify the root cause, and assess
whether the approach is repairable before abandoning it. A rollback may restore the last known-good
baseline while the investigation continues, but rollback alone is not a diagnosis and must not be
treated as sufficient reason to give up. Prefer the smallest evidence-backed correction, rerun the
same frozen evaluation, and reject the optimization only after its remaining correctness risk, cost,
or lack of measurable benefit is understood and documented. If an optimization remains
unsuccessful, report the failed evidence, attempted corrections, and current worktree state, then let
the user decide whether to retain or roll back the candidate unless restoration is immediately
required to prevent further destructive side effects.
