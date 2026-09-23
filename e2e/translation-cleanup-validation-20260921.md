# Translation cleanup: approved scope and validation

## Plan

The user approved three behavior-preserving changes to the existing text-only lens. Preserve
structural layout, local dynamic fallback, manual refresh, context, caches and validation.

1. Remove the unread `visual` collection and `tight` source field from `translation-dom.ts` and
   `translation-text-layout.ts`. Replace tests of the obsolete collection with assertions on text
   discovery, native media and unsupported text. Do not remove native/image-copy rendering.
2. In `TranslationDom.clearPreview`, paint only when a matching preview was removed. In
   `mount-translation-lens.ts`, guard request cleanup with its existing `active` flag. Test genuine
   preview rollback, completed results, and late completion after refresh/close before changing
   production code. Do not skip mutation positioning: native deferred content can move neighbors.
3. Export the existing 8,000-character source, 32-block batch and 16,000-character input-batch
   limits from `region-translation.ts`; reuse them in collection, batching, schemas and context
   anchor selection. Keep output length validation separate from input-batch length validation.

Run the focused DOM/scheduling/protocol tests first, then all translation tests and repository
gates in `EVALUATION_STANDARD.md`. Freeze the resulting build and use the existing canonical
authenticated diagnostic on Baidu, QQ, Lark Docx, Lark Wiki and hao123, including manual refresh.
Review actual screenshots separately from request success/settling. Do not add site-specific
branches, broaden supported content or present a single run as universal stability proof.

## Execution ledger

- Baseline: 92 tests / 3 focused files passed (`translation-cleanup-baseline.log`).
- Preserve inherited uncommitted work in the existing feature checkout; no dependency, branch,
  commit, push, authentication copy or subagent is part of this task.
- The approved conversation plan is the scope authority. Self-review will cover only this cleanup
  against the preserved pre-cleanup files, not reclassify inherited work as newly implemented.
- Red: 4 failures / 99 tests (`translation-cleanup-red.log`) reproduced no-op preview repaint,
  duplicate cleanup after refresh/close, and the second final-completion render. The five protocol
  boundary cases already passed and pin existing limits rather than inventing new behavior.
- Implementation: the three approved changes are applied. The separate 16,000-character output
  limit and the structural renderer remain unchanged. No dependency or site-specific logic was added.
- Self-review: compared all eight touched production/test files with their pre-turn copies in
  `translation-cleanup-baseline.tar`. No independent reviewer/subagent was used. Existing dirty
  changes are preserved; the cleanup remains uncommitted and unpushed.

Evidence paths in this document are relative to ignored `e2e/.runtime/` unless stated otherwise.

## Deterministic validation

| Check                                                                                   | Result                                                                | Evidence                                                                   |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Focused red/green cycle                                                                 | Four expected failures reproduced before the cleanup; green afterward | `translation-cleanup-red.log`, `translation-cleanup-translation-green.log` |
| `npm run test:run`                                                                      | 1,721 tests in 139 files passed                                       | `translation-cleanup-unit.log`                                             |
| `env -u NO_COLOR npm run test:e2e -- --output e2e/.runtime/translation-cleanup-browser` | 176 browser tests passed; includes typecheck and production build     | `translation-cleanup-browser.log`                                          |
| `npm run format:check`                                                                  | Passed                                                                | `translation-cleanup-format.log`                                           |
| `npm run lint`                                                                          | Passed with zero warnings                                             | `translation-cleanup-lint.log`                                             |
| `npm run audit:bundle`                                                                  | Passed, 17 assets                                                     | `translation-cleanup-bundle.log`                                           |
| `npm run check:sandbox`                                                                 | Passed                                                                | `translation-cleanup-sandbox.log`                                          |
| `npm run e2e:catalog:validate`                                                          | Passed, 39 samples                                                    | `translation-cleanup-catalog.log`                                          |
| `./node_modules/.bin/tsx e2e/runner/doctor.ts`                                          | All six checks passed against the frozen build                        | `translation-cleanup-doctor.log`                                           |
| Standalone `e2e/runner/verify.ts` before each live diagnostic                           | Passed, including the declared hao123 retry                           | `translation-cleanup-*-verify.log`                                         |
| `git diff --check`                                                                      | Passed                                                                | Local command output                                                       |

The additional regression cases cover no-op and genuine preview removal, one final-result render,
idempotent cleanup after refresh/close and late completion, source size and batch boundaries, and
continued collection of a smaller source after an oversized one. Tests were not weakened.
The optional shell-token `check:codex` preflight was not run; no browser authentication was copied
or extracted. The native diagnostics below used the existing canonical authenticated profile.

## Frozen live diagnostic

All production changes preceded the build used here. No product code, diagnostic gates or sample
contracts changed between native runs, including the hao123 retry. The two verified bundle hashes:

- `dist/assets/page-content.iife.ts-SGCrsbH1.js`:
  `c1cb8ad24530c4fb15c9b22db05b0c7e6db90d8b84b98f5d6e0dd2af0cc572c4`
- `dist/assets/background.ts--4KMLLad.js`:
  `753055dbd86106e9adf9c6c0065d61b6179670b1aff2120563a030e827fa8550`

These are native translation-lens diagnostics, not WorkSession benchmark passes. Each completed
run covers 14 stages: initial translation, manual refresh, continuous scroll/back, scroll down,
scroll back, cached reopen, resize, move, 125% browser zoom, zoom restoration, refresh after zoom,
and three reopen cycles. A settled state is not proof that all visible text was translated.
Screenshots were inspected separately. Some deterministic browser tests overlapped the first two
native runs using separate disposable profiles; no latency or performance improvement is claimed.

| Site                   | Execution / requests                                                                            | Visual result and limits                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baidu                  | 14/14 stages settled; 5/5 HTTP 200 requests finished                                            | Reviewed navigation and hot-list text retain readable fonts. Long constrained labels can be ellipsized. Inputs and image lettering remain native.                                                                                                                  |
| QQ                     | 14/14 stages settled; 11/11 HTTP 200 requests finished                                          | Reviewed body headlines/cards render readably. A narrow top toolbar still has crowded/clipped English labels, so this is not a perfect-layout pass. Images/video remain native by design.                                                                          |
| Lark Docx              | 14/14 stages settled; 8/8 HTTP 200 requests finished                                            | Reviewed table cells and prose translate with natural wrapping; watermark remains visible. Scroll matching is ambiguous, so the motion probe does not establish zero lag.                                                                                          |
| Lark Wiki              | 14/14 stages settled; 14/14 HTTP 200 requests finished                                          | **Visual coverage not passed:** initial body/table translation works, but manual refresh with a text selection and floating editor toolbar leaves much of the body/table native. Cached reopen translates it again.                                                |
| hao123, attempt 1      | Initial stage failed; 4/5 HTTP 200 requests finished                                            | `MODEL_TRANSIENT`; the last stream contains partial output without a completion event. This is not a layout pass.                                                                                                                                                  |
| hao123, declared retry | Initial stage failed; two requests had HTTP 200 headers but none recorded successful completion | Upstream stream explicitly emitted `error` / `server_is_overloaded`. UI reported `MODEL_INVALID_RESPONSE_SSE_PROTOCOL`. No response content was rendered; an additional pending request is recorded as transport-failed, which alone does not establish its cause. |

Every captured translation request in these runs included non-empty text context and no image
input. This verifies payload inclusion, not whether every model wording decision used that context.

### Evidence directories and invocations

Use `./node_modules/.bin/tsx e2e/runner/verify.ts <sample>` before each invocation of
`./node_modules/.bin/tsx e2e/diagnostics/translation-lens.ts` below. All runs used target language `en`.

| Diagnostic arguments                                               | Evidence directory                                  |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| `translation-baidu-readable en`                                    | `lens-translation-baidu-readable-1789969465789`     |
| `translation-qq-readable en`                                       | `lens-translation-qq-readable-1789969625853`        |
| `translation-lark-readable en '身份与追踪字段' 1440`               | `lens-translation-lark-readable-1789969832636`      |
| `translation-lark-wiki-readable en '模块划分' 1440 '3.1 模块划分'` | `lens-translation-lark-wiki-readable-1789969996888` |
| `translation-random-hao123 en`                                     | `lens-translation-random-hao123-1789970247878`      |
| Same hao123 command, one declared diagnostic retry                 | `lens-translation-random-hao123-1789970485621`      |

Each directory preserves `evidence.json`, original/after screenshots and reached-stage screenshots.
In particular, compare Wiki `initial.png`, `manual-refresh.png` and `cached-reopen.png` rather than
interpreting its empty diagnostic `failures` array as a complete translation pass. Both failed
hao123 attempts are retained, with separate `translation-cleanup-hao123-live.log` and
`translation-cleanup-hao123-retry-live.log`; neither was discarded or replaced by a selected pass.

### Stability and attribution limits

- The four completed runs sampled 233–242 stationary frames each, with no hidden lens or replaced
  translation host observed during those samples. This is bounded evidence, not a universal
  absence-of-flicker guarantee.
- QQ matched 12 scrolling groups over 30 scroll events with no measured offset or host replacement.
  Baidu produced no actual scroll events. Docx had no unambiguous matched group. Wiki's 10 matched
  groups are predominantly sidebar content, not evidence that its body/table remained translated.
- Native pages update themselves. The observed source text/disconnection changes on QQ and Lark
  cannot independently establish either source mutation by the extension or absence of mutation.
- Wiki's selection/toolbar state coincides with native fallback. The existing structural renderer
  contains collision/safety fallback paths, but the precise trigger and causal attribution are
  **not confirmed**. The renderer was not edited in this cleanup; no frozen pre-cleanup live A/B
  was performed, so this report does not label the issue as either newly introduced or pre-existing.
- The earlier pre-cleanup Wiki evidence, `lens-translation-lark-wiki-readable-1789959122214`, has
  52 rendered text entries at manual refresh and a translated table/prose screenshot without the
  floating editor toolbar. This run has 29 entries and the selected heading/toolbar visible. Both
  actual screenshots were compared after the user's attribution question. Their different source
  states prevent a causal before/after conclusion. In particular, removing a redundant paint can
  expose an implicit repaint dependency, so passing unit tests does not exclude that possibility.
- The first hao123 stream failure lacks a completed response. The second has explicit upstream
  overload evidence. The UI's protocol-error classification is a separate provider concern, not
  proof of a text-layout failure. No provider or retry behavior was changed in this cleanup.

## Disposition

The three approved simplifications are implemented and deterministic gates pass. The live matrix
is **not fully passed**, and this is not a claim that every historical translation issue is fixed.
The candidate remains in the worktree with all inherited changes and failed evidence preserved;
there was no rollback, commit or push. No broader renderer/provider change was folded into the
cleanup to mask the remaining results. Retaining or reverting the candidate remains the user's
decision; another live attempt should wait for provider recovery rather than loop until green.

The five production files have the same aggregate line count before and after this cleanup (1,502):
named constants/imports offset deleted fields and collection work. The benefit is removing unread
state, duplicate render/cleanup work and repeated protocol limits, not an unmeasured speedup or a
large line-count reduction. Structural layout, native fallback, context, manual refresh, caches,
late-response guards, input/output validation and original-document protections remain in scope.
