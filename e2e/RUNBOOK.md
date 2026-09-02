# ChatBrowserX Reproducible E2E

This directory is the single home for the reproducible ChatBrowserX evaluation framework.

## What Lives Here

```text
e2e/
├── AGENTS.md
├── RUNBOOK.md
├── EVALUATION_STANDARD.md
├── SAMPLE_SPEC.md
├── playwright.config.ts
├── runner/                    # Environment, live-run, result, and comparison code
├── tests/
│   ├── runner/                # Deterministic framework tests
│   └── browser/               # Playwright product tests
├── samples/
│   ├── example/               # Tracked synthetic format and reconstruction fixture
│   │   ├── sample.json
│   │   └── benchmark/<UTC-batch-timestamp>/{01.json,report.json}
│   └── <sample-id>/            # Ignored; transported outside Git
│       ├── sample.json
│       └── benchmark/          # Created by the first evaluation run
│           └── <UTC-batch-timestamp>/{01.json,...,report.json}
└── .runtime/                  # Ignored machine-local state
    ├── profile/
    └── playwright/
```

The repository tracks the method and one public synthetic example, not real samples or runtime
state. Never force-add another `e2e/samples` directory or anything in `e2e/.runtime`. See
`SAMPLE_SPEC.md` for transport, formats, and direct links to the tracked example files.

## Requirements

- Node.js 24 or 26 in the range declared by package.json; Node.js 25 is unsupported.
- Dependencies installed from package-lock.json with npm ci.
- Chrome available to Playwright.
- One complete `e2e/samples/<sample-id>/sample.json`; the tracked `example` sample is sufficient for
  validating a fresh checkout, while a real evaluation needs its target-specific sample.
- Legitimate access to the Codex Provider and any account required by the target sample.

## Rebuild on a New Machine

1. Check out the repository and install the locked dependency tree.
2. Run the environment doctor.
3. Validate the tracked synthetic example, then receive or create any target-specific sample through
   a controlled non-Git channel.
4. Validate the complete local catalog again after importing target-specific samples.
5. Create a fresh dedicated Profile and complete interactive authentication.
6. Verify the Profile and target independently.
7. Run the declared traffic and retain its result.

```bash
npm ci
npm run e2e:env:doctor
npm run e2e:catalog:validate

# For a real evaluation, receive or create:
# e2e/samples/<sample-id>/sample.json
# Result directories are created only when their first report is written.

npm run e2e:catalog:validate
npm run e2e:live:setup -- <sample-id>
npm run e2e:live:verify -- <sample-id>
npm run e2e:live:benchmark -- <sample-id>
```

Use the tracked [`samples/example/sample.json`](samples/example/sample.json) as the structural
reference when creating a sample on another machine. Create a new directory with a matching new
`id`; do not copy the example's synthetic `benchmark/` history into a real sample.

The doctor checks the toolchain and starts the built extension in a disposable Profile. Setup opens
`e2e/.runtime/profile` for supported UI authentication and the sample's setup instructions. The
Profile is machine-local and must not be copied. Verification checks Provider configuration,
extension access, target origin, and all readiness conditions without submitting a task; execution
checks the same boundary again. `CHATBROWSERX_LIVE_E2E_PROFILE` may select another absolute,
dedicated Profile path.

## Evaluation Commands

```bash
npm run e2e:live:benchmark -- <sample-id>
```

```bash
CHATBROWSERX_LIVE_ALLOW_MUTATION=1 npm run e2e:live:benchmark -- <sample-id>
```

```bash
npm run e2e:live:benchmark -- <sample-id> [runs]
```

```bash
npm run --silent e2e:benchmark:compare -- <sample-id> <left-revision> <right-revision> [runs]
```

```bash
npm run e2e:live:provider-diagnose -- <sample-id>
```

The optional `runs` argument defaults to one. Every invocation creates one timestamped directory
below `benchmark/` and writes its completed attempts as `01.json`, `02.json`, and so on. The runner
stops on its first failure. Each file is one complete bounded and redacted report containing its run
ID; no second raw-report copy is written. After every attempt, the runner atomically replaces the
batch's `report.json` with aggregate counts and averages derived from all completed attempt files.
It contains no per-attempt detail. Provider diagnostics are stored separately below
`e2e/.runtime/provider-diagnose/` and never enter comparable benchmark history.

The tracked synthetic batch under [`samples/example/benchmark/`](samples/example/benchmark/) shows
the resulting attempt and summary layout. Its numbers are illustrative and are not product
measurements or a comparison baseline.

## Concurrent Correctness Runs

Live correctness runs may use at most five workers. Each worker requires a different absolute
Profile path that was created and authenticated through the normal setup flow; never copy an
authenticated Profile. Run setup and verification once for every worker Profile before using it.

Build exactly once before fan-out. During the concurrent phase, do not invoke an npm live command,
edit the product, or rebuild `dist`; invoke the runner directly with a worker-specific Profile and
log path instead:

```bash
npm run build

CHATBROWSERX_LIVE_E2E_PROFILE=/absolute/e2e-profile-01 \
./node_modules/.bin/tsx e2e/runner/benchmark.ts <sample-id> \
> e2e/.runtime/<sample-id>-01.log 2>&1
```

Set `CHATBROWSERX_LIVE_ALLOW_MUTATION=1` for a mutation sample. Do not run the same sample twice at
the same time. Serialize samples that share a remote resource, including the same chat composer,
mail production/readback chain, editor draft, calendar object, or exam attempt. Each worker owns its
Profile, browser process, extension storage, task state, active Tab, log, and result batch; the
frozen build is the only shared runtime input.

The runner enforces the five-worker cap, one-run-per-sample rule, and the exclusive resource keys in
`sample.json`. A conflict fails before browser launch; it never waits while holding another
resource. These locks do not replace independently created Profiles or worker-specific logs.

Concurrency is for correctness throughput only. Run baseline/candidate performance batches without
other E2E load so elapsed time and Provider latency remain comparable.

## Reproducible Baselines

Use a full commit SHA and an isolated worktree. Keep the extension path stable so Chrome keeps a
stable extension identity.

```bash
BASELINE_DIR=/private/tmp/chatbrowserx-baseline
BASELINE_REVISION=<full-commit-sha>
git worktree add --detach "$BASELINE_DIR" "$BASELINE_REVISION"
npm --prefix "$BASELINE_DIR" ci
npm --prefix "$BASELINE_DIR" run build

CHATBROWSERX_LIVE_EXTENSION_PATH="$BASELINE_DIR/dist" \
CHATBROWSERX_LIVE_PRODUCT_REVISION="$BASELINE_REVISION+baseline" \
npm run e2e:live:seed-product

CHATBROWSERX_LIVE_EXTENSION_PATH="$BASELINE_DIR/dist" \
CHATBROWSERX_LIVE_PRODUCT_REVISION="$BASELINE_REVISION+baseline" \
npm run e2e:live:benchmark -- <sample-id> <required-runs>
```

Run the same frozen contract and count for the candidate, then compare the labels under
`EVALUATION_STANDARD.md`.

## Framework Checks

For a narrow harness change:

```bash
npx vitest run e2e/tests/runner
npm run e2e:catalog:validate
npx playwright test --config e2e/playwright.config.ts --list
```

Before completing a framework or product change, run the repository gates listed once in
EVALUATION_STANDARD.md. Browser tests are deterministic product checks; they are not a substitute
for an authenticated live sample run.
