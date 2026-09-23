# Additional translation-lens page checks — 2026-09-20

## Scope fixed before execution

The user asked for additional previously untested pages, not a product change. This is a small
cross-layout spot check, not a statistically representative sample of the web. Six new sites are
selected before looking at translation outcomes. Three use English-to-Chinese and three use
Chinese-to-English. No production edits, new dependencies, commits or pushes are authorized by
this verification request.

The frozen build is `page-content.iife.ts-BnNJer20.js` with
`background.ts-DBM7YBHa.js`. The canonical doctor passed. Use the existing authenticated,
machine-local Profile, standalone verify, and the existing generic native-lens diagnostic.
These native-feature runs are not WorkSession benchmark attempts or benchmark success rates.

Each target gets one initial attempt. A failed attempt remains failed and is classified before
any retry or continuation. Do not weaken acceptance or replace an inaccessible/failed page
silently. No automatic retries are predeclared.

| Target                                                             | Direction  | Width | Focus                                                       |
| ------------------------------------------------------------------ | ---------- | ----- | ----------------------------------------------------------- |
| [Hacker News](https://news.ycombinator.com/)                       | en → zh-CN | 1440  | Compact list, metadata, links, dense navigation             |
| [React](https://react.dev/learn)                                   | en → zh-CN | 1440  | Sticky navigation, prose, lists and adjacent code           |
| [W3C tables](https://www.w3.org/WAI/tutorials/tables/two-headers/) | en → zh-CN | 1024  | Data tables, row/column headers, borders, surrounding prose |
| [Runoob](https://www.runoob.com/html/html-tables.html)             | zh-CN → en | 1024  | Tutorial table, sidebar, long English labels                |
| [Sina](https://www.sina.com.cn/)                                   | zh-CN → en | 1440  | Dense news/navigation, ordinary DOM captions, dynamic page  |
| [JavaScript.info](https://zh.javascript.info/object)               | zh-CN → en | 1440  | Long prose, code, inline markers, section navigation        |

Acceptance requires inspecting original and translated screenshots, not just terminal status:
ordinary selected DOM text must appear translated at readable source typography, natural
reflow or native ellipsis must remain coherent, and unrelated controls/images/code must stay
native. Also exercise continuous scrolling, down/back, available horizontal overflow, cached
reopen, lens move/resize, 1.25 browser zoom and three additional reopens. Preserve screenshots
and bounded request/geometry evidence in ignored `e2e/.runtime/`; do not persist credentials,
raw provider bodies or private source text.

## Results

### Hacker News — failed visual acceptance

Standalone verification passed. Evidence: `e2e/.runtime/lens-translation-random-hackernews-1789894736751/`.
The initial list and metadata translate, but the full-width orange header contracts to its content
width and the right-aligned login text moves next to the submit link. The `scroll-down.png` stage
has a stronger failure: ordinary news rows revert to English while only footer labels remain
translated (`unsupported`, seven displayed spans). Returning up restores the list. This is a
product layout/coverage defect, not an intentional image/input exclusion and not a provider error.
The exact cause is not yet proven. The original and translated screenshots are retained.
No acceptance rule or implementation was changed. Remaining targets continue as independent checks.

### React — failed initial translation

Standalone verification passed. Evidence: `e2e/.runtime/lens-translation-random-react-1789894963449/`.
The initial stage ended with `text/MODEL_ABORTED`, two displayed spans, and a still-unfinished
32-block request. The four-block request completed. Both HTTP statuses were 200, but no upstream
SSE error code was recorded, so this cannot be attributed to overload or called a pass.
The run stopped at this first terminal failure; scrolling/zoom/reopen were not reached.
The cause of the abort remains unresolved. The source screenshot confirms that the displayed
JavaScript string `I'm a button` became Chinese inside the mirrored code example. That
code-content change is a separate observation, not hidden by the request failure; the original
source remains separate from the copy.

### W3C tables — table readable, code-format observation fails full acceptance

Standalone verification passed. Evidence: `e2e/.runtime/lens-translation-random-w3c-table-1789895082552/`.
The run starts at the visible `Delivery slots:` caption at 1024 pixels. The row/column headers,
all visible data cells, prose and sidebar translate with coherent borders and readable type.
Down/back, cached reopen, lens move/resize, 1.25 zoom and three extra reopens completed.
The 32-event scroll sample had two matched groups and zero measured event/frame offsets; the
stationary sample had 196 frames, zero hidden frames and zero replaced groups. Source snapshots
recorded zero text/style changes among 382 elements. Four requests completed without image input.

Do not call the complete page a clean pass: `scroll-down.png` shows the HTML code snippet's
original line breaks/indentation flattened and its literal example labels translated. Repeated
Open/Closed table cells also use inconsistent equivalent Chinese terms across request batches.
The first metadata snapshot says unsupported/seven spans while its subsequent screenshot shows
more translated content and a loading notice; later snapshots are ready. This snapshot/paint
timing difference is retained, not used as proof of a settled first frame.

### Runoob — body readable, sidebar loses translations after scroll

Standalone verification passed despite the preliminary web fetch failing. Evidence:
`e2e/.runtime/lens-translation-random-runoob-1789895219088/`.
At 1024 pixels, the introduction, bullet explanations, navigation and sidebar initially render
readable English without shrinking. All twelve diagnostic stages report ready, but
`scroll-down.png` shows the still-visible sidebar back in Chinese while the body remains English.
This is an ordinary-DOM coverage defect; ready and zero measured scroll offsets are insufficient
for acceptance. The example's literal Chinese labels also become English inside its displayed
HTML source. The native rendered table farther below was not the visually reviewed region in
this initial/280-pixel scroll run; do not claim coverage from the mirrored table count alone.

Four requests completed; context was 1,138–1,817 characters and no image was sent. The continuous
probe had 32 scroll events, three matched groups and zero measured offsets/replacements, before
the later failing down-scroll stage. The stationary probe had 241 frames, no hidden frames or
replacements. Source snapshots recorded zero text/style changes among 1,218 elements.

### Sina — incomplete, screenshot/font readiness blocked evidence

Standalone verification passed. Attempt directory:
`e2e/.runtime/lens-translation-random-sina-1789895574894/`.
The run failed with a 30-second screenshot timeout while waiting for fonts, at the cleanup
`source-after.png` capture. No screenshots or standard evidence JSON were written. Because the
cleanup exception obscured the initial exception and prevented the subsequent settings restore
and evidence write, this is a harness/evidence failure, not a proven translation defect or pass.
The exact observed console error and limitations are retained as `observed-failure.json`.
The dedicated diagnostic Profile may retain the requested English target setting; no personal
browser Profile was used. The attempt is not retried or silently replaced with an easier page.

### JavaScript.info — ordinary paragraphs omitted and code whitespace lost

Standalone verification passed. Evidence:
`e2e/.runtime/lens-translation-random-javascript-1789895676535/`.
The initial screenshot translates the title and sidebar but leaves the first four ordinary
Chinese paragraphs unchanged inside the full-size lens. Some prose below the illustration does
translate. Down-scroll retains the omissions. This is not an image/OCR limitation.
Both requests completed with HTTP 200, 27 and four blocks respectively, with 1,683 and 1,045
context characters and no image input. Request completion therefore does not imply rendered
coverage; the exact point at which these paragraphs are rejected remains unproven.

The two- and four-line code examples collapse into single long, right-clipped lines while their
line-number gutters still display two/four lines. This is a confirmed formatting defect,
separate from the question of whether prose in code comments/string literals should translate.
All twelve stages report unsupported, and the small moved/zoomed lens has no translated spans.
The continuous scroll probe records 32 events, seven matched groups, zero event offsets but a
maximum 24-pixel frame offset in 34 of 129 frames. This is a suspected synchronization issue;
approximate source-to-copy group matching requires further attribution before claiming that
every measured offset is visible ghosting. The 242-frame stationary probe records no hidden
frames or group replacements. Source snapshots show zero text/style changes or disconnected
nodes among 565 elements.

## Overall disposition

This spot check does not support an all-fixed claim. Five sites produced inspectable translation
evidence, and each exposed at least one request, coverage or layout issue; Sina could not finish
evidence capture. These are first attempts, not a statistical reliability estimate. Four sites
completed the twelve-stage interaction sequence, React stopped at initial translation, and
Sina has no usable standard evidence report.

Prioritized follow-up, requiring implementation authorization:

1. Ordinary DOM coverage and scroll persistence: Hacker News news rows, Runoob's sidebar,
   JavaScript.info's paragraphs. Investigate extraction, structural-group rejection, result
   application and scroll/cache invalidation separately; do not assert a common cause yet.
2. Structural fidelity: preserve table/header geometry and preformatted code whitespace.
   Code-comment/literal translation policy is separate from preserving line breaks and syntax.
3. Cancellation/error handling: trace the React MODEL_ABORTED request; no upstream overload
   or 120-second timeout is established by this evidence.
4. Scroll synchronization: attribute JavaScript.info's frame-offset sample before making a
   universal no-ghosting claim.
5. Evaluation reliability: preserve original exceptions and evidence, and restore settings even
   if a cleanup screenshot times out. Sina's product behavior remains unverified.

Requests in the available evidence carry nonempty page context. This verifies transmission, not
that the model always interprets that context correctly or that terminology is consistent.
Source snapshots and screenshots are bounded checks, not proof of all possible page mutations.
Only the selected viewport and diagnostic scroll stages were checked; no claim is made that
every section of these long pages or every website is covered.

## Reproduction and change scope

The six local sample contracts use the existing schema and live profile. No production source,
diagnostic harness implementation, dependencies, commits or pushes changed in this turn.
Samples and raw evidence are machine-local/ignored; this report is the durable summary.
The existing unrelated worktree changes were preserved.

Environment/catalog checks:

```sh
npm run e2e:env:doctor
npm run e2e:catalog:validate
```

For each sample, standalone verification was followed by the existing diagnostic:

```sh
./node_modules/.bin/tsx e2e/runner/verify.ts <sample-name>
./node_modules/.bin/tsx e2e/diagnostics/translation-lens.ts <sample-name> <target-language> [anchor] [width]
```

Sample names are `translation-random-hackernews`, `translation-random-react`,
`translation-random-w3c-table`, `translation-random-runoob`, `translation-random-sina`, and
`translation-random-javascript`. The W3C anchor is `Delivery slots:`; its width and Runoob's
width are 1024. Other targets use the diagnostic's default 1440-pixel width.
No unit-suite or full product-build pass is claimed for this verification-only turn.

Final checks: `npm run e2e:catalog:validate` passed with 35 valid sample contracts;
`npm run format:check` and `git diff --check` passed. All six standalone readiness verifications
passed, which only establishes that the target/profile was usable, not that translation passed.
The page-content/background asset names still match the frozen build listed above.
