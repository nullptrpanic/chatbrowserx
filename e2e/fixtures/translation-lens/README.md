# Region translation feasibility spike

This is the disposable, controlled fixture used before the extension demo. Its `?preview` route
still replays recorded translations; it is not the live extension feature. The minimal extension
entry is documented in `src/translation/README.md`. The original demo on port 4317 is untouched.

## What this proves

- A real `gpt-5.6-terra` request read and translated six English lines: two DOM lines and
  four Canvas lines, including text on a gradient/patterned background.
- `translation.json` contains the unedited model blocks from the second report below.
  Viewport and Canvas geometry are separately measured fixture metadata.
- The preview replays this saved response. Pointer movement does **not** send model requests.
  It demonstrates cached overlay rendering, not live OCR or end-to-end latency while moving.
- DOM coordinates/styles come from the original elements. Image coordinates come from the model,
  mapped from the captured viewport into the current image box.
- The original page is untouched; only translated text/background patches inside the lens are shown.
  Mouse movement uses animation-frame updates. Ctrl+wheel resizes the frame; Escape removes it.

## Actual model runs — 2026-09-09

| Report under `e2e/samples/translation-lens-visual/benchmark/` | Task                          | Acceptance                                                                                 | Agent elapsed | Total tokens |
| ------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ | ------------: | -----------: |
| `20260909T071109.275Z/01.json`                                | Completed, 6/6 lines returned | Failed: the new sample accidentally retained the default maximum of zero image attachments |      21.573 s |       11,456 |
| `20260909T071230.661Z/01.json`                                | Completed, 6/6 lines returned | Passed after contract v2 explicitly allowed the single required screenshot                 |      25.689 s |       11,817 |

Both reports are preserved. The production implementation and the requested model task were unchanged.
Both used two browser inspections and three provider requests. These measurements include the entire
Agent chain and tool schemas; they are **not** measurements of a dedicated one-request translation API.
The sample acceptance checks do not assert pixel accuracy or general translation quality.

## Spatial and interaction checks

Against independent Canvas glyph metrics, the second response's four raw boxes had top-left errors
of 1.85–2.18 CSS px, average intersection-over-union 0.793, and glyph-box coverage of 85.2–86.1%.
Boxes were too short to erase the complete source without padding. The preview adds a generic 4 px
mask margin in the captured image's coordinates, scaled with the displayed image; it does not replace
the model boxes with ground-truth coordinates.

A browser check observed no page errors, a lens resize from 520×230 to approximately 776×343,
prevented the Ctrl+wheel default, and verified Escape removed both overlay nodes while retaining
the original English heading. Seven unit cases check result validation and coordinate projection.

A follow-up resize defect was reproduced: shrinking the browser kept the initial translation
positions and font sizes while the source Canvas reflowed. The overlay now recomputes placement on
resize, scroll, and observed fixture size changes, coalesced into an animation frame. Pointer movement
alone does not rebuild text, and layout changes do not fetch translations again. Four browser regression
cases failed before the fix and passed after it: widths 818/430 and back, content reflow, and scroll/exit.
Failure evidence is preserved under `e2e/.runtime/translation-lens-layout-before/`; passing checks use
`e2e/.runtime/translation-lens-layout-after/`.

## Limits and recommendation

The core idea is feasible, but this fixture does not establish production readiness:

- New-region translation is asynchronous. Cache hits can display immediately; 21–26 seconds through
  the general Agent chain is not suitable for a moving lens. A dedicated bounded request path,
  debouncing, in-memory caching, cancellation, and stale-response rejection still need implementation
  and independent latency measurement.
- A single sampled color hides original pixels acceptably on a plain background, but leaves visible
  patches on gradients/patterns. Arbitrary image background reconstruction is not solved by OCR and
  bounding boxes. The simple version should explicitly accept approximate image overlays.
- Only six single-line blocks on one controlled page were tested. Resizing, reflow and scrolling of
  this fixture are covered; arbitrary dynamic pages, multiline text, translation expansion, iframes,
  native zoom variations, video, and navigation invalidation are not verified. Small-font display
  checks replay existing recognized text; they do not establish fresh OCR accuracy on tiny glyphs.
- Only Ctrl+wheel dispatch was checked. This does not establish interception of browser-toolbar zoom,
  Cmd/Ctrl-plus, or every platform's native pinch gesture.

Start with a dedicated region-only translation path, reuse screenshot/crop and isolated page-overlay
capabilities, and do not add whole-page replacement/restoration, a generic agent task, or persistent
page caches. Keep unknown regions in the original language until valid translations arrive.

## Reproduce

### Live extension demo follow-up

The new `区域翻译 · Demo` entry was exercised through the production screenshot/crop/provider/page
path in the existing authenticated Profile, with no Agent task and no recorded-response replay.
At 1440 px and 818 px browser widths, fresh requests each returned translations for all four Canvas
lines; the corresponding overlays were visually inspected, and Escape removed them. Observed times
were about 9.0 s and 10.1 s, each with one Provider request. These are two manual smoke observations,
not a repeatability or performance comparison claim. Target language was temporarily set to `zh-CN`
and restored afterward. An earlier request with `system` resolving to English correctly returned no
blocks for the English source (6.5 s). Screenshots are preserved under
`e2e/.runtime/region-translation-live-{zh,narrow}-{original,translated}.png`.

The production browser regression uses a mocked Provider with real screenshot/crop/rendering. Its
first failures exposed runtime sender classification and HTTP-page UUID availability; failures are
preserved under `e2e/.runtime/region-translation-{before,after-context,diagnostic}/`, followed by a
passing check under `e2e/.runtime/region-translation-after-http/`.

Use the repository's `e2e/AGENTS.md` and `e2e/RUNBOOK.md` environment sequence before any live run.
The local sample is intentionally ignored, consistent with the real-sample storage policy.

```sh
./node_modules/.bin/vite e2e/fixtures/translation-lens --host 127.0.0.1 --port 4318 --strictPort
./node_modules/.bin/vitest run e2e/tests/translation-lens.test.ts
./node_modules/.bin/playwright test --config e2e/playwright.config.ts translation-lens.spec.ts
npm run e2e:catalog:validate
npm run e2e:live:verify -- translation-lens-visual
npm run e2e:live:benchmark -- translation-lens-visual 1
```

Source fixture: `http://127.0.0.1:4318/`. Recorded-response preview:
`http://127.0.0.1:4318/?preview`. Screenshots from this spike are under
`e2e/.runtime/translation-lens-{original,preview,zoom}.png`.
