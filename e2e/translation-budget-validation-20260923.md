# Translation constraint budget implementation and validation

> Execute inline with `superpowers:executing-plans`; preserve the current dirty worktree.

**Goal:** Keep constraint analysis inside the renderer's admitted safe-copy nodes and isolate a
constraint failure to its own layout island.

**Architecture:** The safe copier already owns a bounded source-to-copy map. Constraint analysis
will consume that map, build a local child index, and inspect only admitted descendants instead
of rescanning arbitrary source subtrees. The existing renderer error boundary owns failures.

**Tech stack:** TypeScript, DOM/CSS, Vitest/JSDOM and production-extension Playwright fixtures.

**Spec:** The approved review in this task and `src/translation/README.md`: one renderer, bounded
copies, unchanged source, source typography, explicit regional fallback, no site-specific rules.

## Constraints and execution decisions

- No interaction, protocol, model, dependency or site-specific behavior changes.
- No commit/push; preserve unrelated work. Stay on the existing feature branch.
- No subagents, per the current repository agreement. Perform a separate author review instead.
- Keep the user's development `dist` unchanged; build and test a frozen scratch candidate.
- Keep existing regression assertions. Narrow RED/GREEN first, quick browser lane next, one final
  complete gate; retain failed evidence rather than rerunning broad suites on each edit.
- This task implements the already-approved narrow fix, not another architectural redesign.

## Review focus

- A small visible island with a large hidden subtree must not inspect excluded descendants.
- Nested line/link/graphic queries must obey the same membership as the top-level constraint pass.
- Sliced flows must not inspect omitted live siblings through their shared parent.
- A failing constraint read must retain source text and not block an independent sibling island.
- Reused groups, tables and compact rows must preserve existing typography and geometry contracts.

## Task 1: Reuse the safe source membership and contain failures

**Files:** `src/page/translation/translation-text-constraints.ts`,
`src/page/translation/translation-structure-layout.ts`, `tests/translation/translation-dom.test.ts`,
`tests/translation/translation-text-constraints.test.ts`,
`e2e/tests/browser/translation-renderer-contracts.spec.ts`, `src/translation/README.md`.

**Interface:** Add the renderer's `ReadonlyMap<Node, Node>` to the internal constraint reader;
the reader still returns `TranslationTextConstraints`. Do not add a separate lifecycle/cache.

- [x] RED: add a real DOM constraint test with 8,000 excluded hidden nodes, asserting no excluded
      geometry reads; cover a sliced root and bounded nested text/link inspection. Add a renderer
      fault-injection test that expects the sibling translation to render and source text to remain.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/translation/translation-text-constraints.test.ts tests/translation/translation-dom.test.ts`.
      Expected before fix: the new budget/isolation assertions fail for the reported defect.
- [x] GREEN: consume the bounded map rather than `root.querySelectorAll('*')`; derive descendant
      traversal from admitted parent-child relationships. Read constraints inside the existing
      regional `try/catch` once the group/map exists. Leave constraint application rules unchanged.
- [x] Rerun the same tests, then all translation units. Expected: all pass, including old cases.
- [x] Add a browser regression using the existing fixture: large hidden descendants beside
      visible prose/navigation, complete translated output, original font size/source invariance,
      and no geometry/style reads of excluded descendants in the extension world.
- [x] Freeze/build the candidate. Run the affected browser regression and eight-case quick lane;
      then the complete repository gates from `EVALUATION_STANDARD.md` once. Expected: all pass.
- [x] Review the final incremental diff, record fresh results and limitations below, and leave
      changes uncommitted. Preserve the verification evidence for handoff.

## Evidence and progress

Review reproduction before implementation: the constraint reader visited 8,003 unique elements
for one visible paragraph plus 8,000 hidden descendants. JSDOM timings are not browser timings.

Evidence directory: `.runtime/translation-budget-20260923/`.
Frozen candidate: `.runtime/translation-budget-candidate-20260923-LrR0N1/`.

| Check                                              | Result                                                                                                              | Evidence                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Confirmed unit RED                                 | All three new regression assertions fail on the old implementation; 56 existing cases pass                          | `red-confirmed.log`                                 |
| Targeted GREEN                                     | 59/59 pass                                                                                                          | `green.log`                                         |
| All translation units                              | 222/222 pass                                                                                                        | `translation-units.log`                             |
| Browser RED with the prior frozen production build | Fails on 32,000 excluded-node style reads, expected zero; source/font/translation assertions before that point pass | `browser-red-confirmed.log`, `browser-red-results/` |
| Candidate browser regression + existing quick lane | 9/9 pass; excluded-node style reads are zero                                                                        | `browser-quick.log`                                 |
| Final complete browser gate                        | 291/291 pass in 6.5 minutes, two workers; exit code 0                                                               | `browser-final.log`                                 |
| Final full units                                   | 1,767/1,767 pass, 144 files                                                                                         | `units-final.log`                                   |
| Final build/typecheck                              | Pass                                                                                                                | `build-final.log`                                   |
| Final formatting/lint                              | Pass; zero lint warnings/errors                                                                                     | `format-final.log`, `lint-final.log`                |
| Bundle/sandbox/catalog                             | Pass; 17 assets, 39 valid sample definitions (not 39 new live passes)                                               | `bundle.log`, `sandbox.log`, `catalog.log`          |

The final browser gate includes table reflow, compact navigation, scrolling/zoom, manual refresh,
source invariance and regional fallback. It was run once against the final frozen build. The
quick lane took 18.7 seconds and final unit tests took 34.51 seconds; these are run durations, not
a controlled end-to-end performance comparison. The comparable performance evidence is the
excluded-node style-read count: 32,000 before, zero after, on the same 8,000-hidden-node fixture.

The initial sliced-flow unit fixture lacked JSDOM range geometry; `red.log` preserves that setup
failure. Adding the same range shim used by existing DOM tests exposed the intended excluded-sibling
read. The initial lint run found forbidden non-null assertions; replacing them with explicit
guards produced the final green lint/build/unit runs without relaxing any rule.

The first browser invocation ran before a broad scratch copy had finished and failed module
discovery (`browser-red.log`). The copy unnecessarily included `sandbox/target`; its temporary
duplicate was moved to Trash, leaving the original untouched. Subsequent snapshots explicitly
excluded build caches, dependencies and historical runtime output. The confirmed RED then used
the unchanged prior build with the new browser assertion. The candidate was rebuilt before GREEN.

`identity.log` confirms all 199 source files match between the workspace and final candidate.
SHA-256 values use JSON-encoded, path-sorted `[relativePath, contentSha256]` manifests:

- Source: `bf53a73089c120407af28cacf3b87ef5bbc67a74b0f1c9e9927452984120730c`.
- Build: `d564fe6877e593846c596e149c1faeca45ab4f1977d91b8e96aa2dfaaac8cedf`.

## Review and scope decisions

- Source membership and source-to-copy bindings still belong to the safe copier. The constraint
  reader derives a paint-local child index; it adds no independent visibility selector or durable
  cache. Line, link, graphic and loose-text reads share that index. External sibling positions
  needed by a detached label remain source layout context, not descendant translation targets.
- Constraint failures use the existing per-island catch, removing only that failed mirror and
  recording its IDs. The regression also verifies recovery from valid cached text on the next
  layout pass. Model settings, request/retry generations and message schemas are unchanged.
- Ruling: retain the existing feature checkout and frozen scratch validation model. This preserves
  the large inherited dirty baseline and avoids changing the user's development build. No commit,
  push, dependency installation or authenticated-profile copying was performed.
- Ruling: perform a separate author self-review instead of delegating, following the repository's
  current-task opt-in requirement. This is not an independent reviewer sign-off.
- The shared layout defect is exercised in a real production extension/browser with deterministic
  provider responses. No new authenticated real-site or model-quality pass is claimed.
