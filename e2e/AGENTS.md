# ChatBrowserX E2E Instructions

These rules apply to every file and operation under `e2e/`.

## Canonical Owners

- `RUNBOOK.md`: canonical environment reconstruction and commands; follow its new-machine sequence
  to produce a runnable, authenticated E2E environment.
- `SAMPLE_SPEC.md`: sample and result contracts.
- `EVALUATION_STANDARD.md`: execution, evidence, failure, and comparison rules.
- `OPTIMIZATION.md`: optimization candidates, admission status, and concise decision history.

## Mandatory Rules

- Keep reusable E2E code, tests, configuration, and documentation under `e2e/`; package scripts and
  the root `AGENTS.md` pointer are the only integration exceptions.
- Use the shared runner and self-contained `sample.json`. Do not add sample-specific authentication,
  scripts, hidden prompts, or code-owned scenario registries.
- Keep `e2e/samples` and `e2e/.runtime` ignored and move them only through a controlled non-Git
  channel.
- Never change product code merely to make E2E pass or improve metrics. A product change requires a
  preserved, reproducible product defect under `EVALUATION_STANDARD.md`; rerun the frozen sample to
  close that defect.
- Never persist secrets or private raw traffic in samples or standard results.
- Require `CHATBROWSERX_LIVE_ALLOW_MUTATION=1` for `page_state_mutation` samples.
- Cap live execution at five concurrent samples. Before fan-out, freeze one read-only build and give
  every worker an independently authenticated Profile, browser process, extension/task storage,
  active Tab, runtime/log path, and result batch; never copy an authenticated Profile. Serialize
  samples that read or mutate the same remote resource, and do not collect comparable performance
  metrics under concurrent load. Follow the canonical concurrency procedure in `RUNBOOK.md`.
