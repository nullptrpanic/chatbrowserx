# ChatBrowserX Project Instructions

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
