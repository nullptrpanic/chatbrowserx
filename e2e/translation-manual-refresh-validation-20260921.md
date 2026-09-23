# Translation lens: manual refresh for changing content

## Accepted scope

Keep the region lens and read-only structural text renderer. Do not restore image translation,
OCR, source-page mutation or site-specific rules. Stop chasing changing/animated text; leave the
affected region native and let the user explicitly retranslate it. Static neighboring text,
document tables and ordinary scrolling retain their existing behavior.

`Alt+R` / `Option+R` refreshes the current lens. Its hint stays immediately outside the upper-left
corner, clamped into the viewport when there is no space above. It uses physical `KeyR` so the
Mac Option-modified character does not prevent activation. Search-field autofocus must not block
the shortcut; the action neither reads nor edits an input/editor draft. Composition, unrelated
modifier combinations and repeated requests from a held key are excluded.

## Changes and simplification

- Reuse the existing DOM collection/context/request/render pipeline, not a second refresh path.
  The error retry button and shortcut share cancellation and rescheduling.
- Keep valid completed text while its replacement is pending. Refresh source IDs and request
  generation together; ignore late previews, results and errors from the previous generation.
  Preserve completed caches outside the current lens.
- Record local manual-refresh boundaries for observed text changes and positional motion. A
  replacement slide inherits its track's boundary instead of immediately starting another request.
  Equivalent document text-node hydration is not a content change.
- Remove the direct animation-position copy synchronization branch and animation/transition-end
  automatic re-entry. Reuse one structural text-track predicate for grouping and local deferral.
- Retain scroll positioning, clipping, source visibility/privacy filters and bounded caches. These
  are not animation-tracking redundancy and removing them would reintroduce overlap/ghosting.

No dependency, public command, source-page write or hostname-specific condition is added. Existing
unrelated/inherited worktree changes are preserved. No commit or push is part of this task.

## Retained failures and corrections

All logs/artifacts below are ignored local evidence under `e2e/.runtime/`, not tracked samples.

1. `translation-refresh-unit-red.log`: five new unit cases fail before implementation; refresh
   did not invalidate completed results and changed text still auto-requested.
2. `translation-refresh-browser-second.log`: 35 pass, two fail. The animated child can be visited
   after its clipped parent, so first discovery missed the full native/unsupported boundary. The
   collector now records it immediately. The second fixture placed its glyphs left of the moved
   lens; correct the fixture, not production visibility. The corrected focused run passes 16 cases
   in `translation-refresh-browser-third.log`.
3. `translation-refresh-full-e2e.log`: 173 pass, two fail. Both old lifecycle assertions demanded
   an automatic request after a content update. They now assert no automatic request and explicit
   shortcut recovery, retaining their original rendering, scrolling and lifecycle checks.
4. `lens-translation-random-hao123-1789957826169`: initial quiet-state succeeds (115 text entries,
   five completed HTTP 200 requests), but the shortcut sends no new request. A deterministic
   autofocus fixture reproduces the input-focus guard in `translation-refresh-autofocus-red.log`.
   Removing that guard permits the dedicated shortcut without exposing editable text to collection.
5. `lens-translation-random-hao123-1789958358385`: the real page has `inputFocused:true`; manual
   refresh now completes five new requests. All 13 recorded stages settle, with 14 completed HTTP
   200 text-only requests overall. The moved small lens falls back after the site's zoom-time
   widget update and stays native on zoom restoration; reopen recovers. This is **not** evidence
   of uninterrupted translated coverage. The final diagnostic additionally exercises manual
   refresh after restoring browser zoom, without relying on reopen to recover.
6. The initial lint run finds 14 forbidden non-null assertions in newly added tests/diagnostic
   checks. Replace them with explicit guards/typed tuples; do not relax lint rules.

The previous continuously-changing hao123 failure
`lens-translation-random-hao123-1789938559490` remains preserved. Its 150-second quiet-state check
was not relaxed. The manual-update behavior is a user-approved scope change, not a renamed pass
for the former automatic-animation requirement.

## Final verification

Deterministic gates on the final production candidate:

| Check                                                                                         | Result                                                              | Local evidence under `e2e/.runtime/`                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm run test:run`                                                                            | 1,713 tests in 139 files pass                                       | `translation-refresh-final-unit.log`                                           |
| `env -u NO_COLOR npm run test:e2e -- --output e2e/.runtime/translation-refresh-final-browser` | All 176 browser cases pass; includes typecheck and production build | `translation-refresh-final-e2e.log`                                            |
| `npm run lint`                                                                                | Pass, no warnings                                                   | `translation-refresh-final-lint-completion.log`                                |
| `npm run typecheck`                                                                           | Pass, including the final diagnostic additions                      | `translation-refresh-final-typecheck-completion.log`                           |
| `npm run format:check` / `git diff --check`                                                   | Pass                                                                | `translation-refresh-final-format.log`; clean diff check                       |
| Environment doctor / bundle audit                                                             | All 6 doctor checks / 17 assets pass                                | `translation-refresh-final-doctor.log`, `translation-refresh-final-bundle.log` |
| Sandbox / catalog checks                                                                      | Pass / all 39 samples pass                                          | `translation-refresh-sandbox.log`, `translation-refresh-catalog.log`           |

The live matrix is a native translation-feature diagnostic, not a WorkSession benchmark. Each
site passes standalone readiness verification before its run. The same sequence exercises initial
translation, shortcut refresh, scrolling, lens movement/resizing, browser zoom/restoration, another
shortcut refresh, and repeated close/reopen. Production assets are not rebuilt between sites.

Frozen production assets: `page-content.iife.ts-BbXHqdp9.js`, `background.ts-Bl1wGwZy.js`.
Live diagnostics use the canonical authenticated Profile and standalone readiness verification,
the real configured provider, text-only requests and the unchanged 150-second quiet-state gate.
No authentication/profile copy, provider mock or source-content edit is used.

| Site      | Evidence directory under `e2e/.runtime/`            | Requests / settled stages | Screenshot review and limits                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | --------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baidu     | `lens-translation-baidu-readable-1789958703001`     | 5 / 14                    | Navigation and hot-list rows retain readable native font sizes; ranks/badges remain separate and long text uses source-sized ellipsis. Search draft/placeholder and image lettering stay native. No page scroll range, so this is not scrolling evidence.                                                                                                                                                                   |
| QQ        | `lens-translation-qq-readable-1789958796338`        | 10 / 14                   | Plain headlines, navigation, product labels and DOM captions over photos translate. Existing title clipping remains; video subtitles and image lettering stay native. All 13 matched scroll groups have zero measured offset over 32 scroll events.                                                                                                                                                                         |
| Lark Docx | `lens-translation-lark-readable-1789958983980`      | 8 / 14                    | Body paragraphs and actual four-/five-column tables translate with normal font sizes, wrapped cell text and expanded row heights, not just the outline. The scroll probe has one ambiguous group and no matched group: no zero-lag claim for this page.                                                                                                                                                                     |
| Lark Wiki | `lens-translation-lark-wiki-readable-1789959122214` | 9 / 14                    | Module table cell text, nested numbered lists and surrounding headings/prose translate; source diagrams remain native. Two matched scroll groups have zero measured offset, but one unmatched group prevents an all-content scrolling claim.                                                                                                                                                                                |
| hao123    | `lens-translation-random-hao123-1789959278026`      | 15 / 14                   | Autofocus no longer blocks the shortcut. Static link grids and article-card text remain readable; some navigation/topic labels still remain Chinese, so this is not a full-coverage pass. Zoom-time widget replacement temporarily leaves the small lens native; the second shortcut restores 18 translated entries without closing the lens. Of 57 scroll groups, 56 match with zero measured offset and one is unmatched. |

The serial matrix exits successfully. All 70 recorded stages settle, all 47 real provider requests
finish with HTTP 200 and nonempty text context, and no request contains an image. Both shortcut
stages issue fresh requests on every site. These transport/settling results are not a promise that
all content is supported. Screenshots reviewed include each site's manual-refresh state, the two
Lark body-table scroll states, and hao123's post-zoom manual recovery. The five stationary probes
observe no lens hiding or translated-group replacement. QQ's post-close screenshot shows the
source page restored; live source-change counters on QQ and Lark are nonzero, so those counters
are not used as a source-nonmutation proof. Deterministic tests cover extension nonmutation.

The optional shell-token Codex preflight was not run; authenticated real-provider requests above
verify the relevant native feature path instead. Earlier failures remain recorded above rather
than being silently dropped. No new site-specific selector is added by this change; the inherited
document adapter is not refactored or broadened as part of manual refresh.

## Intentional boundaries

- A content change may be one-off; it still needs manual refresh. Some pages rebuild widgets when
  zooming/resizing, which can trigger the same rule. This avoids another heuristic/auto-retry loop.
- Refresh is a current-content attempt, not a subscription. Still-moving text can remain native;
  refresh after it settles. Unsupported live media/compositing, input drafts and image-internal
  text remain outside text-only translation.
- Source-sized ellipsis can hide part of a long translation. It is not a promise that every word
  fits simultaneously. Ready/unsupported and a successful HTTP response alone do not prove visual
  correctness; screenshots are reviewed separately.
- Scroll measurements are valid only for unambiguously matched source/mirror groups. Unmatched
  groups, zero scroll range and virtualized-source changes must not be reported as zero-lag proof.
- Rebuild/reload the unpacked extension and refresh old target tabs to replace their injected code.
