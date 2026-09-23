# Expanded translation page validation — 2026-09-21

Status: five of eight planned pages exercised; visual acceptance has **not** passed. The user
redirected the task to an architecture assessment after the React run. GitHub, Wikipedia and
Hacker News were not run in this matrix. This is a read-only verification/review task, not a
product change.

## Fixed scope and acceptance

Reuse the frozen animation candidate recorded in
`e2e/.runtime/rendering-core-20260921/frozen-animation-candidate-sha256.txt`.
Check its source/bundle hashes before and after this matrix. Use the existing canonical,
authenticated Profile serially; do not copy credentials, rebuild during the matrix, or edit
product code. The environment doctor and catalog validation pass before execution. Run standalone
target verification before each native-lens diagnostic.

These are native-feature diagnostics, not WorkSession benchmark attempts. Evidence remains in
ignored `e2e/.runtime/` and no remote page content is edited or submitted. Translation settings
are restored by the existing diagnostic cleanup. Preserve every failure; completion or an HTTP
200 alone does not establish visual acceptance.

The predeclared matrix adds eight targets to the prior five-site validation:

| Page                         | Direction         | Primary coverage                                       |
| ---------------------------- | ----------------- | ------------------------------------------------------ |
| Sina homepage                | Chinese → English | Dense portal navigation, headlines, mixed cards        |
| NetEase homepage             | Chinese → English | Portal columns, overlay captions, media boundaries     |
| Runoob HTML tables           | Chinese → English | Body, sidebar, examples, table text, code preservation |
| MDN HTML table reference     | English → Chinese | Technical prose, sidebar, inline code, examples        |
| React Quick Start            | English → Chinese | Long documentation, headings, code, sticky navigation  |
| GitHub TypeScript repository | English → Chinese | Application navigation, file list, README, controls    |
| Wikipedia browser comparison | English → Chinese | Wide/long data tables, headings, sidebar               |
| Hacker News homepage         | English → Chinese | Dense ranked list, metadata, compact links             |

Use the full existing interaction matrix: initial translation, explicit Alt/Option+R refresh,
continuous scroll and back, scrolling to the next region, cached reopen, lens resize/move,
125% browser zoom and restore, explicit refresh after zoom, and three reopens. Inspect source,
initial, scrolled, zoomed, restored, and reopened screenshots. Check unsupported/rejection IDs,
request completion, context bounds, image absence, source-change attribution, and measured
source/mirror movement. Zero counters with no actual scroll or no matched sources are not a
drag-free pass. Native images, video, input contents, and genuinely moving widgets remain outside
the accepted text-only boundary; ordinary static text omissions remain failures.

## Results

Main runtime log directory: `e2e/.runtime/translation-expanded-20260921-FNM3TO/`.

### Sina — visual acceptance failed

Evidence: `e2e/.runtime/lens-translation-random-sina-1789998769534/`.
Standalone verification and all 14 diagnostic stages finish. All 17 requests return HTTP 200
and finish; context is 278–1,645 characters, with no image input. Initial and refreshed states
both contain 107 translated spans with no reported layout rejection.

That is **not** a visual pass. The initial and manually refreshed screenshots show many short
navigation/section labels reduced to one or two letters plus ellipsis, even while neighboring
space exists. The three source photo cards beneath the central column heading become a blank
white region; they are present in both `source.png` and `source-after.png`. At 125% zoom, the
same blank translated region is visible inside the smaller lens while source photos remain
outside. This confirms an overlay/rendering failure, not missing image translation or a failed
request. No exact internal root cause is claimed without further attribution. The down-scroll
state also retains a block of Chinese recommendations; it reports unsupported but zero render
rejections, so this omission is not automatically credited as an approved dynamic exception.

The broad source snapshot covers 1,382 nodes with zero text/style/disconnection changes. The
scroll probe matches five of seven groups over 132 frames and 42 scroll events, with no measured
offset or replacement in matched groups. The stationary probe records one mirror replacement
and zero hidden frames across 222 frames, alongside page-owned carousel mutations; this is not
a blanket flicker-free claim. Failure evidence is preserved without changing the candidate.

### NetEase — partial; navigation fails visual acceptance

Evidence: `e2e/.runtime/lens-translation-random-netease-1789999031511/`.
All 14 stages finish; 25/25 requests finish with HTTP 200, context 417–1,235 characters and no
image input. Initial/refreshed states contain 72 spans, down-scroll 47, and the last three
reopens 19 each. Initial through continuous-scroll-back report one `native-overlap` rejection;
later states have none. The rejected ID is not individually attributed in this broad run.

Ordinary two-column headlines and static image cards are readable at their native fonts, with
single-row ellipsis and preserved images. However, the main category navigation is mostly
`Ne… / Sp… / Lo… / Fin…` despite successful translation. This repeats Sina's short-label budget
symptom and fails usability, even though no native-overlap is reported for most of these labels.
Moving carousel captions, image ads and native input contents remain original; these are not
evidence of failed OCR, which is intentionally absent. Some other unsupported text remains
unattributed, so the run is not claimed as zero-omission.

The scroll probe matches five groups with one ambiguous group, 136 frames and 32 actual scroll
events, with zero measured offsets/replacements for matched groups. The stationary probe has
235 frames and zero hidden/replaced frames. Source snapshot: 935 nodes, no text changes or
disconnections, one style change not individually attributed. No source-immutability guarantee
is inferred for all page-owned asynchronous UI.

### Runoob — prose/sidebar improve, but code-format and coverage failures remain

Evidence: `e2e/.runtime/lens-translation-random-runoob-1789999341375/`, viewport 1,024×900.
All 14 stages finish. Six requests finish with HTTP 200, context 1,138–1,960 characters and no
images. Initial/refreshed states have 36 spans and two `native-overlap` rejections. The preceding
and following article links visibly remain Chinese. The main heading, list, body and sidebar
translate readably; the sidebar stays translated after scrolling in this run.

The HTML example is **not format-preserving**: lines containing translated Chinese cell/header
text lose their indentation, while neighboring untranslated tag-only lines retain theirs. This
is visible in both the full initial and down-scroll frames; source indentation returns outside
the lens/on close. Syntax coloring alone is not code-format acceptance. Inline code chip
backgrounds also differ from the source. No product patch or revised acceptance was applied.
The initial matrix primarily shows the introduction and code example, not the rendered table
further down; the presence of a copied `table` in metadata is not counted as visual table coverage.

Source snapshot: 1,223 nodes, zero text/style/disconnection changes. Scroll probe: two of three
groups matched, 160 frames, 32 events, no matched offset/replacement. Stationary: 241 frames,
zero hidden frames or replacements.

### MDN — main prose works; header coverage and inline styles are not closed

Evidence: `e2e/.runtime/lens-translation-mdn-readable-1789999498687/`.
All 14 stages finish, with no recorded render rejection. Six requests finish with HTTP 200;
four carry context (up to 2,266 characters), two have empty context. No image input is sent.
The heading, introduction, contents and compatibility callout translate legibly. Scrolling does
not visibly paint prose over the sticky header. The interactive example remains native, not a
proof of static-table translation coverage. Header/promo labels remain English and are not
individually attributed; they are not counted as a complete-coverage pass. Inline code chip
backgrounds also differ from the source, repeating the style-preservation issue seen on Runoob.

Source snapshot: 785 nodes, zero text/style/disconnection changes. Scroll probe: five of six
groups matched, 118 frames and 32 scroll events, no matched offsets/replacements. Stationary:
242 frames, zero hidden frames/replacements. Empty context is observable, but these requests
alone do not establish that ordinary article prose lacked context; context deliberately excludes
navigation ancestors and can return empty when none of the batch's anchors survives filtering.

### React — readable body, but component layout and scroll-time coverage differ

Evidence: `e2e/.runtime/lens-translation-random-react-1789999640178/`.
All 14 stages finish. Seven requests finish with HTTP 200, no image input; six have context up
to 1,839 characters and one has empty context. Initial and refreshed views have 31 translated
spans and no render rejection. Body prose, sidebar, headings and the preserved preformatted
code remain legible. However, the initially wide search control becomes a small centered pill
inside the mirror. After scrolling the header returns to English and the state is unsupported,
with no per-ID render rejection. Cached reopen restores 31 spans. The exact header deferral
cause has not been individually attributed, so this is not declared a static-coverage pass.

Source snapshot: 1,152 nodes, zero text/style/disconnection changes. Scroll probe: four of four
groups matched, 138 frames and 32 events, no matched offsets/replacements. Stationary: 242
frames, zero hidden frames/replacements. Source, initial and down-scroll images were inspected;
completion of the other stages is not a claim that every screenshot was visually approved.

## Architecture assessment prompted by this matrix

These are findings against the current working tree, not claims that all defects were introduced
by its latest consolidation. The frozen source/bundle hash check passes again after the review.
No product source, tests, build, dependencies, authentication or execution path was changed here.

1. **Layout policy still has multiple writers.** `translation-structure-layout.ts:959` copies
   styles but also changes compact labels, navigation and every button's intrinsic sizing.
   `translation-text-constraints.ts:414` subsequently changes the same width, flex, whitespace
   and clipping properties. Row conversion allocates flex growth from original cell widths;
   detached label budgets can cap translated text at its original Chinese content width.
   Sina/NetEase's severe truncation and React's shrunken search control are consistent with
   this policy risk. Exact per-element causality for the portal labels is still to be isolated.
2. **Inline translation is not a structure-preserving text replacement.**
   `translation-structure-layout.ts:1328` rebuilds marked content as new spans/anchors using
   only `translationTypography`, removes original text nodes and prunes empty wrappers.
   Backgrounds, padding and other inline box semantics are not retained by that representation.
   `translation-dom.ts:36` normalizes whitespace, while the code exclusion is tag-based (`pre`).
   These are concrete lossy paths matching missing code-chip styling and non-`pre` example
   indentation. They should be corrected at the shared representation, not by site selectors.
3. **The renderer also reconstructs composition and scheduling dependencies.** Its 1,760
   lines own ancestor promotion, flow slicing, safe cloning, application, collision-driven
   subdivision, backdrop painting, cutouts, sticky/scroll alignment and watermark placement.
   `TranslationDom.paint()` discovers additional targets from the reflowed mirror and feeds
   them back into collection. This feedback is needed for newly exposed text, but ownership
   and a bounded discovery/paint cycle should be explicit. Merely splitting the file does not
   remove these dependencies. Sina's blank photo area is confirmed visually, but its exact
   composition branch remains unproven.
4. **Ready is request completion, not full visible-text or readability acceptance.**
   `mount-translation-lens.ts:159` reaches ready when known entries have no missing result.
   Early discovery exclusions have rectangles rather than the renderer's per-ID reasons.
   A missing candidate or a one-letter ellipsis can therefore evade the existing completion
   counters. Some fixture tests check full DOM text, bounds and ellipsis, which do not by
   themselves prove the visible label is useful. Keep existing pixel/immutability tests and
   add explicit shared coverage/readability contracts before accepting further optimizations.
5. **The source boundary is not completely site-independent.**
   `translation-document.ts:4` explicitly recognizes Lark/Feishu domains and editor classes
   to distinguish document text from drafts and to preserve document watermarks. This is an
   existing source/privacy adapter, not a general layout rule. Deleting it as redundant would
   change support/privacy behavior. Any strict removal needs a demonstrated safe replacement;
   do not add portal-specific layout branches or broaden all contenteditable elements.

Recommendation: retain the text-only model/protocol path, bounded context, result validation,
session cancellation, caches, lens and explicit dynamic refresh. Make a focused renderer-core
correction: one layout-policy owner, structure-preserving inline mapping, explicit bounded
source-to-copy planning, and attributable coverage/visual acceptance. This is more than another
threshold patch but does not justify an entire translation-system rewrite. Do not remove native
surface, draft, watermark or stale-result guards merely to reduce the code size. No implementation
is authorized by this architecture-review request.
