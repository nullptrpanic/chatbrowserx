# Archived image-translation feasibility evidence

Archived on 2026-09-16: image translation has been removed from the product at the user's request.
The runnable image-translation spike, saved replay and obsolete automated cases have been removed.
This document records historical experiments, not current product behavior or verification.
For the supported DOM-text-only feature, see [translation architecture](../../../src/translation/README.md).

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

Current scope: translate DOM text only and leave all image content unchanged. Historical runtime
screenshots and reports referenced above are retained as evidence, not active fallbacks.
