# Region translation — DOM text only

Build with `npm run build`, reload the unpacked extension, and refresh existing pages after an
update. Click **区域翻译** beside Screenshot. The lens uses the configured model, reasoning effort,
token and UI language. It does not create an Agent task, chat history or tool loop.

## Interaction and guarantees

- The movable lens translates source text in its observation region. Ctrl+wheel / trackpad pinch
  resizes it up to the viewport. Toolbar zoom and Cmd/Ctrl-plus keep their normal behavior.
- **Alt+R / Option+R** retranslates the current lens with newly collected source text and context.
  The shortcut hint remains immediately outside the upper-left corner (clamped into view at the
  viewport edge). The chord works even when a search input/editor has focus, without reading or
  modifying its draft. Ordinary typing, composition and held-key repeats are not intercepted.
  A known block whose text changes or starts moving stays native until this explicit refresh;
  unaffected static siblings and newly discovered content keep translating normally. Even a
  one-off content change follows this rule; there is no automatic ticker/animation recovery loop.
- Inside the lens, bounded **read-only structural copies** use the page's typography and layout.
  Translated paragraphs and table rows can grow; original single-line ellipsis stays single-line.
  The browser lays out words, links, icons and badges together. There is no per-paragraph font
  shrinking or per-glyph masking. Original and translated lines need not align across the frame.
- The source page's text, styles, inputs and collaborative document are never patched or hidden.
  Closing with Escape, the toolbar, navigation or tab deactivation removes the reading surface.
  Completed translations survive Escape/reopen for the same document/model/effort/language.
- Images and image-internal text are not translated. Static images may appear unchanged in a
  structural copy using the original URL/object-fit. Canvas, video, frames and other live surfaces
  remain native. There is no OCR, image model input, screenshot, debugger or screen-sharing path.
  Objects explicitly typed as supported images (including SVG) use an inert `img` copy at their
  original size; interactive HTML/PDF objects remain native. Preformatted `pre` examples keep
  their original code, strings, comments, whitespace and indentation; surrounding prose translates.
- If a copy would grow into a live surface or independent flow, preserve compact text's existing
  ellipsis contract at its original line budget first, then subdivide disjoint structural boxes.
  Only a still-conflicting island remains original; independent sibling text keeps translating.
  Overlapping photo/caption layers and inline prose are not split apart. The unsupported notice
  explains this intentional fallback. A region containing only images is ready, not a failure.
- Model errors wait for explicit **重试** (only failed blocks) or the full-region refresh shortcut.
  Movement does not retry failed requests. Within a completed, valid response envelope, each block
  is independently validated: successful text remains visible and cached, while malformed or
  omitted known blocks keep their source text and an error. Ambiguous identities, invalid JSON,
  interrupted streams and responses with no valid blocks still fail the batch; markers are never
  guessed or repaired. Only safe stage/code errors are exposed, not raw responses.
  Refresh keeps still-valid completed translations while awaiting replacement, cancels previous
  requests before sending new ones, and rejects late results from the previous refresh generation.
  Completed caches outside the lens are retained. Still-moving content stays native even on refresh.
- A temporary page-state query failure retains the lens and completed text. Once the background
  re-verifies the same active session, discovery resumes without re-requesting completed results.
  This recovery does not clear model failures or replay a toggle.

## Ownership and data flow

| Owner                                      | Responsibility                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `TranslationLensView`                      | Frame, clipping, notice and pointer/zoom/Escape/refresh input                   |
| `TranslationDom`                           | Bounded discovery/reconciliation, source identities, local outcomes and cache   |
| `TranslationStructureLayout`               | Bounded inert copies, original CSS, native reflow, clipping and safe fallback   |
| `translation-geometry`                     | Batch-local source/copy geometry and explicit visible/hidden/uncertain clipping |
| `translation-text-constraints`             | One source-derived compact label/row budget, applied without font fitting       |
| `translation-animation`                    | Shared appearance/layout/motion classification; no additional lifecycle state   |
| `translation-context`                      | Source-anchored reference context, collected only for uncached requests         |
| `mount-translation-lens`                   | Scheduling, previews, session lifecycle, retries and stale-response correlation |
| `TranslationController` + `translateTexts` | Page authorization, model calls, result validation and cancellation             |

There is one model path:

Complete DOM blocks → bounded text/context request → ID/marker validation → structural text copy.

There is also only one renderer. The former glyph masks, proportional font-fitting, photo-byte
verification and `translation.background` worker/debugger route have been removed. Obsolete image
and background protocol messages are rejected. Ordinary screenshot and Agent browser tools remain
independent and unchanged. No new dependency or site-specific rendering rule is introduced.

## Structural rendering

Discover complete logical blocks, keeping mixed inline prose together and independent navigation
labels separate. Hidden menus, closed disclosure bodies, clipped accessibility labels, form values
and editable drafts are not translation targets. A partly visible ordinary paragraph/table cell can
be collected in full; its copy retains the source ancestor's clipping boundary.
An offscreen ancestor alone does not exclude its descendants: fixed islands and visible overflow
can remain in view. Discovery uses the same bounded walk and checks actual text/clip visibility;
it does not require a previous visit or cached identity to find an escaped visible island.
Rectangular `clip-path:inset(...)` and legacy `clip:rect(...)` are measured consistently by discovery,
context and rendering. Zero-area clips stay hidden; unsupported shapes stay native. Negative and
fractional insets are retained, including document tables panned to the left of their article.
When both clip declarations are present their intersection is used; an empty accessibility clip
does not become a false visible obstacle that rejects a neighboring text label.
Geometry snapshots copy primitive facts only and expire at the end of each synchronous read/paint
batch. Normal overflow uses the actual scrollport; absolute/fixed descendants skip intermediate
overflow until their containing block, including transformed containing blocks. Proven empty clips
do not protect invisible obstacles. Unknown shapes keep conservative native protection, but are
not accepted as safe target paint. Context can still include mounted prose beyond the viewport.
Overflow clips descendant content at the padding edge, not the element's own painted border.
Native obstacle bounds and foreground cutouts share that distinction; explicit clip paths and
ancestor clipping still apply to the entire box.

Animation classification checks actual effects, not only property names. Browser zoom can emit
`transition:all` events with identical border-width keyframes, or quantized outline/rule widths
whose styles are `none`. These do not make static text dynamic. Real painted-width, transform,
opacity and content motion retain the manual-refresh boundary; no resize grace timer is used.
Animation/transition completion and cancellation remeasure already-deferred native boundaries,
so a vanished overlay does not leave static cached translations rejected at its old position.
This does not clear the dynamic boundary or request the animated text again.
Native scrolling and ordinary user wheel gestures share the existing scroll/settle lifecycle.
This includes custom table scrollers that pan with CSS instead of dispatching a native scroll
event. Ctrl/Meta wheel zoom and synthetic wheel events do not start that gesture; source text
changes and actual animation effects still retain the manual-refresh boundary.

Promote each block through a bounded safe ancestor flow so adjacent paragraphs, rows and sections
reflow together. Sticky headers remain part of their table/paragraph flow; only fixed boxes are
independent islands. Preserve external scrollports. Do not promote through
live controls, media, animated text, shadow roots, unrelated writable content or the document body. A
discovered fixed descendant is owned by a separate paint island and omitted from the normal-flow copy; its
presence alone must not split the surrounding tables and paragraphs. Existing paint order and
native-surface cutouts still protect that independently positioned content. Unobserved fixed controls
retain the existing grouping boundary. A
`display:contents` wrapper is not a paint box. Invisible editor caret sentinels are not draft text
and do not split a read-only table into separate cell overlays.
Native element bounds are remeasured when applying model results, using the same current geometry
as foreground cutouts. A toolbar that moves while a request is pending must not reject the whole
document at its former position. This does not make deferred moving text automatically eligible.
Absolute native foregrounds, including selection tooltips, use that same cutout owner when they
already overlap the source flow and paint above it. They do not reject all text in a sliced flow.
Cutouts follow current clipped bounds. Media outside the original flow is still a collision when
only translated expansion reaches it; source stacking order and native pixels remain protected.
If only empty expanded backing reaches an external surface in the same scroll flow, the existing
ink check can cut out that backing without dropping the translation. Actual glyphs, graphics,
borders and differently moving surfaces still prevent that cutout.
Foreground collision checks use the same painted descendants as the cutouts, rather than a
transparent fixed/sticky container's empty bounding box. Deferred branches inside a pinned owner
also retain an independent painted footprint, even when an opaque ancestor covers them; empty
sidebar space is not a native text obstacle. A scan stopped by the existing node or
surface budget, or an uncertain clipping shape, retains the conservative native boundary.
Pinned foregrounds also protect source-owned structural overflow outside the main flow box,
such as a wide panned table. The source-box overlap restriction for adjacent absolute media
does not apply to those existing pinned foregrounds.
Native collision checks exclude a static decoration only when the safe copy map already owns
its actual readonly copy (for example a rotated arrow beside a news headline). Subtree membership
alone is not proof: live media, unsupported clip shapes and independent fixed controls cannot
enter that map and remain protected. External composited tooltips also remain native obstacles.
Pure positional CSS translations used by virtual lists are allowed; their measured source origin
is applied once. Scrollports inside percentage/flex shells keep their actual used height and scroll
position rather than expanding to the full virtual-list height. Individual CSS `translate` offsets
are preserved as well as `transform`, so clipped carousel slides stay separated. Text-free decorations no larger
than 48 × 48 CSS pixels may be copied as static icons; their original animation remains untouched.
Color-only and decorative box-shadow transitions/keyframes (including a separate TOC highlight
mask or scroll-triggered header shadow) do not remove stationary readable text. Every animated
property is checked; mixed movement/opacity still remains native.
Text observed during an entrance animation
can be translated by manual refresh once it stops; animation/transition completion does not
automatically rejoin it or trigger another request.
An independently clipped viewport containing text in only absolutely positioned slides keeps its own
layout island between transitions. A changing ticker must not repeatedly regroup and shift
neighboring static labels; stopped readable text becomes eligible on manual refresh. Empty clipped
decorations, such as table resize handles, do not split the table from its following prose.

When native media sits underneath a foreground header or popup, browser hit-test order identifies
the original occlusion independently of CSS positioning mode. The island may keep translating only
within original opaque coverage (solid color or full-size RGB-only linear gradient), with every
original and translated glyph/graphic contained. Transparent baseline/padding outside that coverage
is clipped rather than painted white over the media. A parent backdrop may supply coverage for a
static list beside a native input only when it also paints above the protected media. A white page
behind a transparent popup is not proof. Rounded borders use their conservative rectangular interior;
alpha/partial backgrounds, foreground media and expanded text retain native protection. Out-of-flow
copies retain at least the original background/border height; shorter text must not add a second border.

Copy resolved visual styles and CSS Typed OM layout values. Retaining `auto`, percentage sizes,
unitless line heights, table layout, grid columns and flex behavior avoids freezing every source
dimension into a pixel slot. The mirror root retains the measured source width, including fractional
CSS pixels; its opaque painting area includes overflowing wide tables without changing column
layout. Existing CSS zoom is preserved once, not used as a font-fitting mechanism.
Detached table rows and row groups receive a table sizing context so their measured width is
honored. An isolated cell beside native content receives a fixed single-cell table context,
preserving its column boundary and vertical alignment even for long clipped text.
Only retained copies consume the 6,000-node layout budget: discarded parent attempts do
not prevent otherwise safe child islands from rendering.
Read the original label/row contracts using the safe copier's bounded source-node map, including
nested text/link/graphic queries. Hidden or omitted sibling subtrees are not rescanned through a
shared ancestor. Constraint reads share the island's error boundary, so one failed read does not
interrupt independent translations. Copy ownership remains with the renderer; the child index is
local to the current paint, with no additional cross-paint cache. Apply their common
width/line budgets once, then measure protected boundaries; collisions no longer switch to a
second compact-text heuristic. Ordinary inline spans retain their inline formatting, while flex
labels shrink independently of their icons. A parent budget cannot erase a child's explicit
maximum width or reserve the same padding twice. Multi-line clamps use the text owners' line
heights, including nested typography/zoom, rather than the wrapper's inherited font. Fixed and
maximum heights permit complete lines only. A compact section's clamped labels share the space
before the next independent flow/native surface: if their combined potential growth exceeds that
space, they keep their original occupied line counts. Otherwise declared multi-line clamps remain;
unbounded prose and absolutely positioned photo captions are not frozen to one line.
Relative maximum widths stay CSS expressions when combined with measured budgets: `100%` is
never parsed as `100px`. Intrinsic maxima are accounted for by the source's measured width.
Inline-block labels and badges retain their original vertical alignment; a width constraint does
not force them to the top of a line. A sole nested label in an adaptively shared row aligns its
box directly so ellipsis cannot introduce an extra anonymous baseline descent. Sibling icons and
ordinary inline prose keep their original alignment.
Overflowing or tightly crowded single-row flex menus retain their native font size and ellipsis contract.
Clipping belongs to the cell's formatting context: an inline anchor may stay inline under its
clipping cell, while a label directly in a flex cell receives its own bounded block box.
Height-bounded single-row left/right-floated menus and inline-block utility rows use the same
spacing and ellipsis policy if translation crowds their cells. Floats without a height or clipping
contract retain natural wrapping and move following clear-flow content down. Existing multi-row
collections remain multi-row.
An explicitly one-line height/max-height with clipped overflow remains a bounded row even when
its source uses flex-wrap. Padding is not extra line space; preserve flex cross-axis alignment
and margins instead of forcing nowrap. Auto-growing and ample-height wrapping groups remain
native. Tight inline navigation is recognized from its visible glyph band when borders extend
beyond the line box. Its shared gap replaces a sole nested label's positive outer margins only
when those margins do not reserve a sibling, background or mask icon.
Adaptive row budgets apply only to rows containing translated text. Pure graphic subrows retain
their original spacing, including deliberately overlapping avatar/icon stacks.
Padded labels are classified by their actual glyph bands, not padding height or the assumption that
font ink fits inside CSS line-height. Icon/separator sizes and original maximum widths
are reserved; an intrinsic float column may use the verified empty gap before a fixed neighbor,
but two intrinsic columns cannot both claim it. Overflow-clipped extra menu rows stay clipped.
Non-rendered HTML comments do not change a link cell's classification.
The rule does not convert multi-row menus or ordinary prose.
Only the constraint plan adapts translated layout; copying styles does not independently resize
buttons or guess short-label widths. A full-width control retains its declared width. Button copies
remain native button boxes (inert, non-submitting and unfocusable) so their anonymous content
alignment is preserved. Shared rows use intrinsic capped flex sharing: short labels keep their
intrinsic width while longer labels share the remaining space, instead of proportional shrinking.
Inline label/icon pairs retain one line; text-free graphic widths do not get a text intrinsic cap.
Photo cards (graphics larger than the existing 48-pixel icon allowance) keep their native row,
image dimensions and margins even when their one-line captions become longer.
Whitespace-preserving prose (`pre-wrap` / `break-spaces`) is not compact navigation merely
because the source happens to fit one line beside a number or icon; it keeps natural wrapping.
Compact single-line flex toolbars may mix links, plain labels and icon-only actions. Their text
labels, rather than the whole cells, own ellipsis so icons/badges are preserved at native size.
The same single-line constraint applies inside copied inline markers; a nested explicit normal
white-space value cannot silently wrap an otherwise bounded headline.
If a live sibling splits a compact nowrap toolbar, its detached static labels keep their original
cell widths; they must not borrow each other's spacing while the dynamic cell remains native.
Fixed-height single-line labels retain their slots, and fixed carousel cells clip excess text
before it can overlap the next slide. Detached inline-block roots retain their internal formatting
context without adding an outside baseline/descender below their measured source box.
Compact inline actions beside an originally non-overlapping absolute graphic retain their source
slot as well: out-of-flow graphics must not become spare space for longer translated text.
Independently fixed utility labels that cannot display their full translation stay original with
the existing partial-unsupported notice (`label-overflow`). The same fallback covers a bounded
single-line readout narrower than three em when its translated ink is clipped: one or two letters
plus an ellipsis is not a readable result. Measure fractional geometry after shared-row allocation;
roomy controls still translate and ordinary title ellipsis is unchanged. Restore affected labels
and their source layout through the existing safe copier in one synchronous replacement, keeping
neighboring valid translations. Merely inserting original text into an already narrowed translated
box can clip the original too. Settled groups retain the fallback decision until their source,
available width or model values change; scroll alone never rebuilds them. No smaller fonts,
vertical rearrangement, source writes or new request/retry path is introduced.
Original cells reserve their measured widths even when a neighbor still translates. If that exposes
another clipped tiny label, resolve it within the same synchronous transaction before painting;
each pass removes at least one translated entry and is bounded by the group's entry count.
Detached one-line inline labels retain that slot even with intrinsic height, so their text cannot
overflow into an independently positioned ticker. Naturally sized float-clearing ancestors do not
clip a growing column to their old resolved height; explicit height/max-height, aspect ratio,
existing source overflow, horizontal clipping and collision boundaries remain intact.
Text-only invisible separators retain their layout space in the copy. They remain hidden, inert,
and excluded from translation; `display:none`, editable content and live controls stay excluded.
Single-line list items whose text consists of links normally reflow; only when expansion would
cover an independent region do they retain their original row and ellipsize at the native font.
Fixed-width inline-block cells with an ellipsis contract pass their width budget down through
nested label wrappers, including icon padding; an atomic wrapper must not bypass text ellipsis.
Fixed controls excluded from a sliced sibling flow still cut holes in that flow's backing, even
when they share its parent; membership is based on copied children, not the common parent.
An independent sibling intersecting only empty expanded backing does not reject the whole island.
Bounded glyph/graphic checks permit a cutout at that sibling's footprint; actual text, borders,
images, gradients and independently scrolling surfaces remain protected. A final pass also checks
the sibling's translated footprint, since it may grow after the first island was laid out. These
cutouts follow cached source-relative geometry during scrolling without remeasuring text.
Foreground ownership also includes positioned positive-z-index containers, not only fixed/sticky
elements. Bounded discovery continues below an opaque ancestor to retain a dropdown that paints
outside that ancestor's box; covered descendants do not add redundant cutouts. Independently
stacked descendants retain their own paint boundary. This protects native inputs and overflowing
menus without changing source stacking or raising the existing node/surface budgets.
Transparent structural overflow receives an ancestor backdrop only within its visible rectangles;
both the original footprint and the reflowed copy are covered, since preceding text can move a
table away from its original position. Each footprint retains its own inner clipping, so this does
not expose old glyphs or paint over an entire neighboring column. Static watermarks cover the same
disjoint rectangles. Clipped overflow rectangles are processed largest-first so nested decorations
do not unnecessarily fragment a covering container. Complex fragmentation remains bounded to 64
paint regions per island.

Small nowrap navigation labels can grow as flex items; source ellipsis contracts remain intact.
If translation overflows an originally fitting, single-row link menu, first reduce excessive
inter-item whitespace, then use flex shrinking and native ellipsis at the original font size.
This structural rule also covers inert/action anchors without an `href`; it does not make them
new active links or depend on any site's classes.
Buttons are inert reading copies with a native-size minimum height, not squashed text boxes. Static
photos, colors, gradients and allowed SVG decoration compose with the copied layout instead of
per-word white masks. Unrepresentable effects and unsafe growth remain original, not silently
rendered as unreadable or overlapping translations.
CSS masks and background-image icons retain their shape and intrinsic size next to translated
labels. A separate decorative background behind a group is resolved from the source paint stack,
not only its ancestors, so white navigation does not lose its blue/image backdrop. During movement,
the cached backdrop sources are repositioned without hit-testing the page again.

Source mutations invalidate affected islands. Width changes rebuild them off-DOM and swap them
synchronously. Streaming updates replace only translated spans in an existing island.
The same appearance-property classification serves CSS animations and inline-style changes.
Static typography/viewport/browser zoom changes remeasure layout and reuse valid translations;
they do not clear the manual-refresh boundary of neighboring text that actually moved.
For sliced flows, the invalidation boundary is the copied children, not unrelated siblings in their
shared parent. Changes to the parent or its ancestors still invalidate the layout. Compact label
budgets use the text content box after subtracting CSS borders/padding, retaining fractional sizes.
Updates inside still-hidden, never-copied widgets do not rebuild unrelated text; revealing a widget
still discovers it. This includes empty overflow-clipped surfaces, but not zero-height wrappers
whose visible descendants overflow normally. Content changes and script-driven positional motion
defer the smallest observed affected block/track instead of synchronizing an animation copy each
frame. Deferral follows replacement branches, not their shared parent: deleting a temporary popup
must not retire static article/table siblings. Short animation pauses still do not restart a track.
Explicit refresh includes a deferred branch's content bounds, so an empty portal wrapper cannot
make its visible descendants permanently unrefreshable.
Semantic-equivalent document hydration preserves source identity. Typography and other static
styling changes still trigger structural invalidation; scrolling retains its dedicated geometry path.
The first preview is immediate; further cumulative previews are coalesced into the newest snapshot
at 100 ms intervals so a burst of table-cell results does not queue one full layout per cell.
Completion, failure and closing discard queued previews; unfinished text is never cached.
Position-only scrolling updates the same island nodes and source scroll positions; it does not
clear the lens or refit fonts. The scroll handler immediately synchronizes cached island geometry,
external clips, backgrounds and fixed watermarks without collecting text or measuring descendants.
New source discovery, dirty copies and arriving model results reflow after 100 ms without scrolling;
results are still validated and cached during the gesture. Full overflow backdrops, not just their
currently visible slices, are retained so newly exposed table rows do not leak original glyphs.
Stream errors end the deferral immediately so failed previews are removed with the error state.
Source DOM order determines reading order even when requests finish out of order or all results
are cached. Independent layers retain their positioned ancestor z-order, keeping sticky navigation
above scrolling article/table copies. The existing bounded discovery also retains fixed/sticky
source surfaces: translations clip around higher native surfaces even when a control prevents
copying the header. Scroll updates reuse these element identities and their current rectangles.
Partial floating panels cut out only their footprint, not the entire underlying text island.
Transparent fixed/sticky wrappers are not themselves paint surfaces. Bounded discovery retains
only their painted descendants or native controls/media, so an empty notification portal does not
cut a stripe through the translated text. Scroll updates still reuse cached element identities.

When shorter translations bring previously off-screen text into the mirror's visible region,
discover those copied source nodes within the same bounded layout. They pass the usual source
privacy/visibility filters and enter the existing request/cache scheduler; hidden menus and
editable drafts are not made into new targets. No full-page eager request is introduced.
Discovery/registration belongs to `TranslationDom.reconcile`, not the renderer's paint step.
Each pass is bounded; a newly exposed cached target schedules a further paint through the existing
timer, without a model request or synchronous recursive rendering. A pass without new identities
stops. The visible observation retains at most the discovery budget's 10,000 target identities.
Source-to-copy mappings follow the current translated span, not its removed raw text node.
Later observations include these visible copies before reconciling source blocks, so hydration
does not restore original text merely because that block is still off-screen in the source.
The bounded walk does not discard an unknown subtree solely because its ancestor is offscreen;
fixed sidebars are discoverable even on the first visit. Hidden, editable and actual glyph/clip
visibility checks still apply; off-screen source text is not eagerly translated.

The copy is inert: no source script, event handler, custom element behavior, editable attribute or
input value is copied. Translation strings become text nodes, never HTML. Paired `<mN>` markers
preserve local typography and source links; unknown/duplicate/unbalanced markers are rejected.
Safe ancestor paths also preserve inline backgrounds, borders, padding, semantic tags and shared
links across marker reordering. Static graphics and generated decoration move with their safe
shells once; no raw source HTML is interpreted. Literal indentation/newlines in non-`pre`
whitespace-preserving text are source-owned metadata, not formatting the model must reconstruct.
Noncollapsing edge spaces, including NBSP and Unicode spacing, are also retained under normal
white-space; ordinary HTML formatting newlines still collapse according to the source CSS.
Neutral editor spans may be coalesced, but identical font properties alone do not make decorated
or semantic shells neutral.
Link URLs come only from the source. Normal clicks forward to the original link; modified clicks
use its safe href. Wheeling over copied links forwards to the original scrollport chain, so the
shadow tree does not trap nested document scrolling.

## Document safety

Local diagnostics expose opaque target IDs and distinct pending, model-failed, unchanged-result,
preview, rendered, layout-rejected, layout-error and awaiting-layout outcomes, plus discovery
boundary counts. These contain no source text, URLs or credentials and produce no network
telemetry. `ready` means requests settled, not proof that the model translated every term; live
validation must inspect both these outcomes and visible source/copy coverage.

The existing Feishu/Lark Docx discovery adapter recognizes both direct `/docx/` and `/wiki/`
document entry points. It remains narrowly scoped to recognized document text and static watermark
surfaces: a Wiki URL alone does not make nested drafts or another embedded editor translatable.
It is an editability/privacy boundary, not a layout override.
Real drafts and nested inputs stay excluded, and the translator never writes to the document.
The renderer uses the same table/paragraph/CSS rules on all hosts; it has no Baidu, QQ, JWT,
Hugging Face or Feishu hostname/class checks. Static watermarks are reproduced over the copy at
their source position and are neither removed nor changed on the original document.
Canvas-backed whiteboards are not DOM text. Reading structured nodes through a platform API would
require a separate adapter/authentication path; the current extension does not provide that path.

## Context, requests and cache

Before an uncached request, gather nearby DOM text around the **requested source nodes**, not the
pointer position or the beginning of `body.innerText`. Walk neighboring text and headings inside
the nearest article/main (or body). Exclude hidden content, navigation, forms, drafts and overlays.

The reference context is limited to **6,000 characters total per request**, shared by all targets.
For one target it is approximately 3,000 before / 3,000 after, lending unused capacity to the other
side. Page title/current-text identifiers share that limit. Context is untrusted reference data in
**user input**, never system instructions or extra translation targets. It is actually sent to the
model; that does not guarantee every term will be interpreted correctly.

- Source discovery: 10,000 distinct nodes per pass, including nested block extraction; reaching
  the bound reports partial support, without discarding earlier complete blocks. Revisiting an
  admitted node while extracting its block does not admit additional source nodes; a block cut off
  mid-extraction is excluded, never sent as a truncated paragraph. All admitted
  visible blocks retain their IDs/results across 32-block requests, including dense link grids.
  Entries and completed results each retain at most 128 additional offscreen blocks; that LRU
  allowance must not truncate the active viewport or evict pending visible IDs. Revealed text
  is bounded by the existing structural-copy budget, not by the offscreen cache size.
- Structural copies: a 6,000-node aggregate budget, which a complete table may use without
  being split into independently sized rows. Normal block-flow siblings can form a bounded
  fragment when their larger parent contains unrelated live media or exceeds that budget.
  The fragment keeps table/prose reflow together without cloning the whole editor. Flex/grid
  internals and live/editable surfaces remain boundaries. Sibling discovery is also bounded.
- Overflow backing follows actual painted structure, not a container's full `scrollWidth` or
  transparent interaction gutters. It must not cover neighboring navigation or annotations.
- Requests: two slots, 32 blocks / 16,000 source characters per batch; 120-second text deadline.
- Context traversal: bounded before/current/after scans, at most 2,048 nodes across 32 anchors.
- Completed results are keyed by source identity/text and model/effort/language. Previews and
  invalid output never enter the completed cache. Stale/disconnected source results are ignored.
- Context-only changes do not invalidate a completed translation. Refresh recomputes it.
  Closing aborts pending work; retry is explicit rather than an implicit retry loop.

## Verification and intentional limits

Each layout pass replaces its internal rejection map with per-source opaque IDs and one of:
`geometry-uncertain`, `native-overlap`, `peer-overlap`, `layout-budget`, `unsafe-copy`.
Local diagnostics read these codes from the closed overlay; no source text, private URL, model
response, network telemetry or new public message is added. Successful later paint clears stale
reasons. Uncollected text and model failures are separate from layout rejection; a missing ID is
not evidence that an entire page was covered.

See `e2e/translation-lens-layout-validation.md` and `e2e/translation-regression-repair-20260920.md`
for deterministic and real-page evidence, including
failed candidates. A model HTTP 200 or a `ready` status alone is not layout acceptance. Browser tests
cover native sizes/ellipsis, links, icons, wide tables, scrollports, CSS zoom, source invariance,
streaming, cache reopen, request shape, security and explicit unsupported fallback.

| Case                                                           | Behavior / remaining limit                                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long text beside live video/Canvas or an independent flow      | Keep an unsafe island original; translate independent safe regions. No video/Canvas placeholders.                                                           |
| Oversized/virtualized document                                 | Only mounted, bounded DOM can translate. Off-DOM content is discovered when the page mounts it.                                                             |
| Raw text directly in `body` or a label containing a live input | Keep unsafe text native rather than copy the entire page or cover the control. Independently safe paragraphs still translate.                               |
| Source ellipsis, fixed clipping, unusual compositing           | Preserve intentional ellipsis; unsupported transformed/animated text may remain original. Arbitrary CSS paint equivalence is not promised.                  |
| Source vs. mirror reflow                                       | Newly exposed readable mirror text is discovered and translated within the same bounds. The mirror is not a separately scrolling translated document.       |
| Browser compositor scrolling                                   | Nodes are reused, but a JavaScript-positioned overlay can lag asynchronous compositor scrolling briefly. Zero frame-lag is not guaranteed.                  |
| Context/translation quality                                    | A bounded neighborhood can miss distant definitions; context-only cache changes need refresh. Live quality and latency are not inferred from fixture tests. |

Image text is intentionally outside this feature, not a partially failed translation. Retired image
failure evidence is retained locally; it is not counted as current text-layout coverage.
