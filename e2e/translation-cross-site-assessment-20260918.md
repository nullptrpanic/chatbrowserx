# Translation lens: cross-site assessment, 2026-09-18

## Scope fixed before the live runs

Assessment only: do not change production behavior during this sweep. Use the canonical
authenticated profile and native lens diagnostic with real Provider responses, not WorkSession
benchmark results or mocked translations. The environment doctor passed. The frozen content build
is `page-content.iife.ts-DXVqNwfV.js` (same production state as the preceding Wiki investigation).

One attempt per entry. Preserve any failure, classify it before proceeding to an independent
entry, and do not retry to select a better result. Public sites are additional layout samples,
not site-specific production adapters. Private document content stays in ignored local evidence.

| Order | Sample                         | Target language | Width | Initial location    | Primary coverage                                |
| ----- | ------------------------------ | --------------- | ----- | ------------------- | ----------------------------------------------- |
| 1     | translation-baidu-readable     | en              | 1440  | Top                 | Navigation, truncation, badges, hot-search rows |
| 2     | translation-qq-readable        | en              | 1440  | Top                 | News grid, native media, mixed backgrounds      |
| 3     | translation-hf-safety          | zh-CN           | 1440  | Top                 | Article typography and inline links             |
| 4     | translation-lark-readable      | en              | 1024  | 身份与追踪字段      | Narrow editable-document tables, horizontal pan |
| 5     | translation-lark-wiki-readable | en              | 1440  | 模块划分            | Large table and following whiteboard boundary   |
| 6     | translation-wikipedia-table    | zh-CN           | 1024  | General information | Dense public native table and sidebar           |
| 7     | translation-mdn-readable       | zh-CN           | 1440  | Top                 | Technical prose, code and interactive example   |
| 8     | translation-github-readable    | zh-CN           | 1440  | Top                 | Dynamic repository UI and file-list table       |
| 9     | translation-jwt-readable       | zh-CN           | 1440  | Top                 | Form controls mixed with explanatory text       |
| 10    | translation-minify             | zh-CN           | 1440  | Minify!             | Simple article, code and unchanged raster image |

Each native run records source and translated screenshots, 32 small wheel events, a larger
scroll down/back, horizontal pan when present, Escape/reopen, stationary stability, lens resizing
and lens movement. Lens resizing is **not browser zoom**. Browser zoom and long-session stability
are not covered by this sweep.

## Acceptance and evidence rules

- Inspect actual screenshots, particularly initial vs scroll-down and reopened/moved states.
- A ready status or nonzero translated-node count is not coverage acceptance.
- Ordinary text, including table cells, must remain readable and translated after scrolling.
- Preserve source font hierarchy, flow/truncation, icons, column boundaries and source content.
- Image pixels, native player content and Canvas-only whiteboard text are known unsupported
  capabilities, not successful translations. Report them separately from ordinary DOM failures.
- Provider/context counters show what was sent, not semantic proof that the model used it.
- Geometry probes only measure matched DOM groups; they cannot prove the absence of all
  compositor ghosting, especially when no actual page scrolling occurred.
- These one-attempt diagnostics do not establish a statistical website success rate.

## Results

**The renderer is not ready for a cross-site success claim.** Ten page targets on nine sites
were attempted with one frozen build. Nine completed native translation diagnostics; the Wiki
attempt stopped at its exact-heading locator before making any translation request. This is an
assessment baseline, not a successful release evaluation or a statistical success rate.

All ten attempts report product revision
`d503bbb9b9d8081e126e427aabf9903002558350-dirty-6cefa08ef513be3b`.
The content asset remained `page-content.iife.ts-DXVqNwfV.js` throughout the sweep.
No production code was changed during the sweep or the follow-up root-cause probes.

### Reviewed real-provider screenshots

Evidence directory names below are relative to `e2e/.runtime/`. Each successful native diagnostic
contains `source.png`, stage screenshots and `evidence.json`. Private screenshots remain ignored
and local; this report does not reproduce private document text or model payloads.

| Target                                          | Observed result, not a whole-site guarantee                                                                                                                                                                                                                                                                                                                                                     | Evidence directory                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Baidu, en, 1440                                 | The inspected navigation and ten hot-search rows are readable, at native text sizes, with single-line truncation and badges. No tiny-font or letter-by-letter wrapping defect was observed. The search input placeholder and logo remain original by design. The page did not actually scroll in this viewport, so this is not scroll acceptance.                                               | `lens-translation-baidu-readable-1789713351455`     |
| QQ, en, 1440                                    | News headings, lists and DOM captions translate legibly, but the entire blue category-navigation strip becomes blank/white. Its translated spans exist; this is a paint failure, not a missing response. Small product icons also appear reduced. Raster banners/player pixels intentionally remain original. **Fail.**                                                                         | `lens-translation-qq-readable-1789713415987`        |
| Hugging Face article, zh-CN, 1440               | Title/body hierarchy and inline links are readable. After scrolling, shorter Chinese prose exposes the next English heading inside the lens without translating it. A transformed Team badge remains unsupported. **Incomplete DOM coverage.**                                                                                                                                                  | `lens-translation-hf-safety-1789713529596`          |
| Direct Lark Docx, en, 1024                      | The two inspected table areas, prose and headings translate readably; horizontal panning reveals translated columns and watermarks remain. This is a positive result for these specific sections, not all Lark tables. A slow page-query/long-task signal remains.                                                                                                                              | `lens-translation-lark-readable-1789713644462`      |
| New Lark Wiki, en, 1440                         | Environment readiness passed, but the exact `模块划分` heading locator timed out before opening the lens: zero translation requests and zero rendered stages. The current UI/TOC structure differs from the prior investigation; no document revision equivalence was established. **No valid product verdict from this attempt.** The earlier same-build table-on-scroll failure remains open. | `lens-translation-lark-wiki-readable-1789713760094` |
| Wikipedia browser-comparison table, zh-CN, 1024 | Translated table header and rows have different widths; columns no longer line up. Menu/search icons become solid squares. A matched-group frame probe also reports up to 4.40625 px offset. **Fail.**                                                                                                                                                                                          | `lens-translation-wikipedia-table-1789713854166`    |
| MDN table reference, zh-CN, 1440                | Body and contents list are readable, but CSS-mask icons become rectangles; after scrolling, translated article content paints over the sticky navigation. Some navigation text remains original. Code and interactive examples are intentionally not translated. **Fail.**                                                                                                                      | `lens-translation-mdn-readable-1789713952555`       |
| GitHub TypeScript repository, zh-CN, 1440       | File-list descriptions and inspected UI text are readable, but relative-time labels remain English. A 216.8 ms frame gap was recorded. The README was not reached and is not validated. **Partial coverage, not a complete pass.**                                                                                                                                                              | `lens-translation-github-readable-1789714063992`    |
| JWT tool, zh-CN, 1440                           | Most explanatory prose translates readably, while the ordinary Encoded Token label remains English and header logo/theme graphics disappear. A lower heading remains English after reflow. Input/editor values are intentionally untouched. **Fail.**                                                                                                                                           | `lens-translation-jwt-readable-1789714168407`       |
| Austin Henley Python article, zh-CN, 1440       | The inspected Minify heading, prose and links remain readable; code/raster content remains unchanged. No major layout failure was observed in this section. Possible small residual link-colored pixels were not isolated; this is not pixel-perfect or semantic-quality acceptance.                                                                                                            | `lens-translation-minify-1789714240422`             |

Two clear public failures can be reviewed directly:
[Wikipedia columns and icons](.runtime/lens-translation-wikipedia-table-1789713854166/initial.png)
and [QQ missing navigation](.runtime/lens-translation-qq-readable-1789713415987/initial.png).
The sticky-header failure is in
[MDN after scrolling](.runtime/lens-translation-mdn-readable-1789713952555/scroll-down.png).

### Requests and context

- The nine native runs recorded **32 translation requests, all HTTP 200**, with no image input.
  HTTP success and a ready UI did not prevent the visual failures above.
- **31 requests contained nonempty context**; one MDN batch contained none. Observed context
  lengths were at most 5,938 characters.
- Code review confirms request-local, DOM-anchored context in the JSON user input alongside
  `language` and `texts`, limited to **6,000 characters total per request**, not 6,000 on each side
  of every block. The system instruction tells the model to use context for meaning/terminology
  and treat it as untrusted data. Navigation/form filtering can leave a batch without context.
- This establishes that context is supplied, not that every model answer used it correctly.
  Translation semantics and terminology accuracy were not scored in this layout sweep.
- The confirmed table/icon/background failures occur after successful responses; retries or a
  larger context budget will not fix them.

### Scroll and source-safety limits

The diagnostic generated 32 small wheel gestures and sampled matched source/copy groups, then
captured larger scroll, reopen, resize and move stages. Most matched groups reported zero sampled
offset, but this is not proof of absence of compositor ghosting or sticky occlusion:

- Baidu generated **zero actual scroll events**, because its page fit the viewport.
- Wikipedia recorded 16 offset frames, maximum **4.40625 px**, with 11 of 13 groups matched.
  Correlation/sticky behavior still needs an isolated regression before attributing every offset.
- GitHub recorded a maximum frame interval of **216.8 ms** and one replacement during the scroll
  probe. The metric does not isolate extension work from website work.
- Direct Docx recorded a maximum page-query duration of **651.7 ms** and a **616 ms** long task.
  Their precise cause was not profiled in this sweep; they are performance investigation signals.
- The two-second stationary samples recorded no hidden frame, but Wikipedia/JWT each had one
  group replacement. This does not establish long-session stability.
- QQ and Lark source snapshots include dynamic text/recycling changes. The counters do not
  attribute mutations to a particular actor. Production code and diagnostics were inspected for
  source writes, but this sweep alone is not a causal source-invariance proof.

## Root causes and repair scope

Follow-up shape probes use synthetic `译 ` prefixes solely to compare source and copy topology and
styles. They use the canonical session, make no Provider call, remove their own overlay afterward,
and are **not translation acceptance runs or successful reruns**. Their JSON evidence is local:

- `shape-audit-translation-qq-readable-1789714338382.json`
- `shape-audit-translation-wikipedia-table-1789714402672.json`
- `shape-audit-translation-mdn-readable-1789714667317.json`
- `shape-audit-translation-hf-safety-1789714733554.json`

| Problem family                                        | Evidence and confidence                                                                                                                                                                                                                                                                                                                                                    | Smallest credible repair direction                                                                                                                                                                                                                   | Scope / expected benefit                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CSS-mask/static graphics lost                         | **Confirmed.** Wikipedia and MDN source icons have a CSS mask; copies have none, while their solid background survives. The visual-property allowlist omits mask properties. Other missing SVG/logo cases require separate attribution.                                                                                                                                    | Preserve the static visual dependencies when copying; test masks and referenced SVG assets without restoring image translation. Do not hide failures by deleting icons.                                                                              | Small for CSS masks; small-to-medium for the broader graphics family. High benefit across sites.                         |
| QQ navigation backing is wrong                        | **Confirmed paint mismatch; exact backdrop element not fully traced.** Seventeen translated spans are present in the missing strip. The source/copy navigation boxes match. The root/ancestor chain is transparent until the white body, while the visible source strip is blue. The renderer reconstructs only ancestor backgrounds and ends in an opaque white fallback. | Make backing/compositing preserve the real visual context, including non-ancestor paint where needed. Do not hard-code QQ colors or only change white text to black.                                                                                 | Medium: clipping, transparency and overlapping surfaces must remain correct. High benefit.                               |
| Large tables lose shared column layout                | **Confirmed.** The public table has 2,498 descendant elements, exceeding the 1,800-node group budget even before text nodes. It is split into standalone THEAD/TR/TH/TD copies. A source row is 975 px wide, but synthetic copies range from 74.6 to 746.9 px; each lays out independently.                                                                                | Keep the semantic table skeleton and shared column/row constraints when bounding work. Cover colspan/rowspan and horizontal clipping. Raising the budget alone only moves the failure threshold and increases cost.                                  | Medium: a generic table/layout correction, not a site rule. High benefit and correctness priority.                       |
| Continuous table/heading flow falls back to original  | **Previously confirmed on the same production build, not revalidated by this Wiki attempt.** A translated table grows into the following independent heading; the collision guard rejects it. Prior evidence shows 44 spans/two table copies initially, then 17 peripheral spans/no table copy after scrolling.                                                            | Give connected flow an explicit shared layout boundary or coherent bounded flow representation, so ordinary following content can move together. Preserve the native-media boundary rather than rejecting a whole ordinary table.                    | Medium-to-large within the renderer. Necessary for the reported Wiki case; not solved by the route fix alone.            |
| Reflow exposes untranslated text                      | **Strongly supported.** HF's original next heading is at y=1073.8 after source scroll 280, outside the 900 px viewport. In the real Chinese copy it becomes visible higher up. Collection uses the original viewport while the copied flow can shrink. JWT has a similar visible symptom, not independently isolated.                                                      | Reconcile translated-copy visibility with collected source IDs using a bounded continuation pass. Avoid unrestricted full-page translation or silently exposing untranslated ordinary text.                                                          | Medium, common to articles and tool pages. High benefit.                                                                 |
| Sticky layers and scroll/frame stability              | **Visual occlusion confirmed on MDN; timing root causes not fully isolated.** Scrollable article copies paint over native sticky UI. Matched-group geometry alone misses this. The frame/performance signals above remain open.                                                                                                                                            | Preserve the original paint order/occlusion boundaries between scrolling and pinned regions; isolate timing regressions with controlled fixtures and real scroll replay.                                                                             | Medium. High benefit, but no claim that one CSS change removes all ghosting.                                             |
| Ordinary labels near controls/custom elements omitted | **Visible symptom confirmed.** GitHub time labels and JWT's Encoded Token label remain original. Code conservatively excludes shadow roots and prevents grouping through controls; the precise cause of each label is not fully isolated.                                                                                                                                  | Separate readable static labels from protected input/editor contents; evaluate readable shadow content without mutating live controls or inventing per-site selectors.                                                                               | Small-to-medium for ordinary labels; broader shadow-component coverage may be medium.                                    |
| Canvas whiteboards                                    | **Known capability gap, not a font defect.** Previous read-only Wiki inspection found two Canvas layers and no DOM text in the board container. A separate structured export proves text exists in platform data, not that the browser extension currently has access to it.                                                                                               | Requires a new source: generic visual recognition/OCR, or an authenticated platform adapter. The former revisits the intentionally removed visual path; the latter conflicts with the preference for generic support and adds auth/maintenance work. | Large/uncertain, separate design and approval. Do not promise DOM-only coverage or silently re-enable image translation. |

The prior Wiki/whiteboard evidence and unclosed defects remain recorded in
[the earlier validation report](translation-lens-layout-validation.md#remaining-document-coverage--not-complete).
The relevant same-build native run is `lens-translation-lark-wiki-readable-1789706070708`;
the table-growth root-cause probe is
`translation-lark-wiki-readable-layout-cause-1789705693449`.

### Architectural conclusion

The model request, context and text-cache path does not need a rewrite to repair the confirmed
layout defects. The main weakness is the interaction between three existing responsibilities:
source visibility/collection, bounded structural copying, and overlay painting/positioning.
Independent layout islands work for many simple sections but can sever shared table/flow
constraints, lose paint dependencies, or disagree with the final visible region.

Repair those shared rules and keep the existing lens/source-immutability contract. Per-site
selectors, larger arbitrary limits, smaller fonts, or treating ordinary tables as approved
unsupported media would not resolve the demonstrated correctness problems. A whole application
rewrite is not justified by this evidence, but the table/continuous-flow work is more than a
one-line patch. Implementation has not been started in this assessment turn.

## Proposed verification gate for the next implementation

1. Freeze deterministic fixtures for each confirmed failure: large/merged tables beyond the
   group budget; a growing table followed by prose and Canvas; masked icons; a transparent
   navigation over a separately painted backdrop; pinned headers; shortened translations that
   reveal additional content; static labels next to editors.
2. Assert the final visible coverage, shared column boundaries, readable font hierarchy,
   truncation/badge space, preserved graphics and source invariance. Do not accept a result solely
   from HTTP 200, `ready`, or translated-span counts. Each ordinary DOM omission must be accounted
   for; input/image exclusions must be reported separately.
3. Re-run this frozen multi-site matrix using the canonical profile and real Provider. Inspect
   source/translated/scroll/reopen screenshots, not just generated metadata. Preserve the first
   failure and its unchanged contract before any correction/rerun.
4. Make Wiki navigation robust to virtualized content by recording document/section identity
   and reaching the section through visible navigation before freezing a new contract. Do not
   relax the exact-heading check and reinterpret this failed attempt as a pass.
5. Add actual browser zoom, a narrow/wide viewport pair per difficult layout, repeated open/close,
   longer scrolling and dynamic-content updates. This sweep only samples 1024/1440 widths across
   different pages and two seconds of stationary state; it does not cover those combinations.

Prioritize table/continuous-flow correctness and paint loss first, then rendered-visibility
coverage and sticky/scroll behavior. CSS-mask preservation is a small independent correction.
Keep whiteboard source selection outside this text-only renderer repair until its scope is
explicitly chosen. These are relative scope estimates, not committed delivery dates.

## Changes and fresh validation in this assessment turn

- Added this assessment record and three local canonical sample contracts for Wikipedia, MDN
  and GitHub to cover public table, documentation and repository-UI layouts.
- Used the existing native lens diagnostic unchanged. The ignored shape probe is supplemental
  root-cause evidence, not a reusable alternative authentication/execution harness.
- `npm run e2e:env:doctor`: passed all six checks, including the typecheck/build sequence.
- `npm run e2e:catalog:validate`: all 29 sample contracts valid.
- Standalone `e2e/runner/verify.ts` readiness passed for all ten targets. The Wiki's later locator
  failure is explicitly separate from environment readiness.
- Nine native real-provider runs completed; one pre-translation locator failure. The failures
  in the results table are not marked fixed or accepted.
- Full unit/browser suites were not rerun for this assessment-only change. Their earlier passes
  are not fresh evidence for this cross-site matrix.
- `prettier --check e2e/translation-cross-site-assessment-20260918.md`: passed after formatting.
- `git diff --check`: passed. This includes the existing tracked diff; it does not convert the
  live failures above into passing results.
- Existing uncommitted work was preserved. No commit, push, dependency addition, remote document
  edit, permission change or image-translation restoration was performed.
