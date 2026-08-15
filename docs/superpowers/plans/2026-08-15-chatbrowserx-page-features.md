# ChatBrowserX Page Features and Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore and improve image input, multi-image attachments, viewport/region screenshots, image preview, and selected-text Translate/Ask AI while keeping all chat/task orchestration outside the webpage.

**Architecture:** The Side Panel owns attachment selection and previews; the on-demand isolated content script owns selection geometry and temporary page overlays; the Service Worker owns visible-tab capture and attachment persistence. Page code exchanges only bounded commands/results and never receives credentials or full task repositories.

**Tech Stack:** React, Clipboard/File APIs, Chrome tabs capture API, Canvas/OffscreenCanvas, Shadow DOM-isolated overlays, IndexedDB Blob attachments, Vitest/jsdom.

**Spec:** Read `docs/superpowers/specs/browser-agent-project-spec.md` first; its approved normative body is `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`.

## Global Constraints

- Complete the foundation, browser-core, and Provider plans first.
- Keep full chat/settings/history UI out of page content scripts.
- Hide all extension page overlays before screenshot capture and restore them in `finally`.
- Store Blob data once and refer to it by `AttachmentId`.
- Never put image data URLs into task events, logs, or repeated message records.
- Support multiple images but enforce explicit count and byte limits.
- Do not add PDF, scrolling-page stitching, desktop capture, camera, microphone, or audio.
- Do not commit or push.

---

### Task 1: Attachment Validation and Object-URL Lifecycle

**Files:**

- Modify: `src/attachments/attachment-types.ts`
- Create: `src/attachments/attachment-policy.ts`
- Create: `src/attachments/attachment-service.ts`
- Create: `src/attachments/object-url-registry.ts`
- Create: `tests/attachments/attachment-policy.test.ts`
- Create: `tests/attachments/attachment-service.test.ts`
- Create: `tests/attachments/object-url-registry.test.ts`

**Interfaces:**

- Consumes: roadmap `AttachmentRepository`, `Clock`, `IdGenerator`.
- Produces: `AttachmentService.addImages`, `AttachmentService.removeReference`, `ObjectUrlRegistry`.

- [ ] **Step 1: Write failing attachment policy tests**

Cover valid PNG/JPEG/WebP/GIF, invalid SVG/HTML/text, empty files, one image over 10 MiB, more than eight images, and combined size over 30 MiB.

```ts
expect(validateImageBatch([pngFile])).toEqual({ ok: true, files: [pngFile] });
expect(validateImageBatch(Array.from({ length: 9 }, () => pngFile))).toMatchObject({
  ok: false,
  code: 'TOO_MANY_IMAGES',
});
```

- [ ] **Step 2: Run attachment tests and confirm failure**

Run `npm run test:run -- tests/attachments`.

Expected: FAIL.

- [ ] **Step 3: Implement exact image limits and storage metadata**

```ts
export const IMAGE_POLICY = {
  acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  maxCount: 8,
  maxBytesPerImage: 10 * 1024 * 1024,
  maxBytesPerMessage: 30 * 1024 * 1024,
} as const;
```

`AttachmentRecord` includes ID, Blob, MIME type, byte size, width/height when known, source (`paste`, `file`, `viewport_capture`, `region_capture`), createdAt, and reference count. File names are optional display metadata and must be stripped of path segments.

- [ ] **Step 4: Implement object URL cleanup**

`ObjectUrlRegistry.acquire(id, blob)` reuses one URL per attachment and increments a refcount. `release(id)` revokes at zero; `releaseAll()` revokes every URL on Side Panel unload. Tests mock `URL.createObjectURL` and `URL.revokeObjectURL` and assert exact calls.

- [ ] **Step 5: Verify attachment primitives**

Run:

```bash
npm run test:run -- tests/attachments
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Search IndexedDB writes and confirm the Blob exists only in the attachment store. Do not commit.

---

### Task 2: Paste/File Image Draft Controller and Preview Dialog

**Files:**

- Create: `src/side-panel/chat/use-image-draft.ts`
- Create: `src/side-panel/chat/image-clipboard.ts`
- Create: `src/side-panel/chat/ImageAttachmentStrip.tsx`
- Create: `src/side-panel/chat/ImagePreviewDialog.tsx`
- Create: `tests/side-panel/chat/use-image-draft.test.tsx`
- Create: `tests/side-panel/chat/ImageAttachmentStrip.test.tsx`
- Create: `tests/side-panel/chat/ImagePreviewDialog.test.tsx`

**Interfaces:**

- Consumes: `AttachmentService`, `ObjectUrlRegistry`.
- Produces: `useImageDraft`, accessible attachment strip and preview dialog for the later composer.

- [ ] **Step 1: Write failing paste/file/multiple-image tests**

Test clipboard `File` items, file-input images, mixed text and image paste, duplicate Blob identities, eight-image cap, removal, Backspace removal when text is empty, and object URL cleanup on unmount.

```tsx
await user.upload(screen.getByLabelText('添加图片'), [firstPng, secondPng]);
expect(screen.getAllByRole('img', { name: '待发送图片' })).toHaveLength(2);
await user.click(screen.getAllByRole('button', { name: '移除图片' })[0]);
expect(screen.getAllByRole('img', { name: '待发送图片' })).toHaveLength(1);
```

- [ ] **Step 2: Run focused UI tests and confirm failure**

Run `npm run test:run -- tests/side-panel/chat/use-image-draft.test.tsx tests/side-panel/chat/ImageAttachmentStrip.test.tsx tests/side-panel/chat/ImagePreviewDialog.test.tsx`.

Expected: FAIL.

- [ ] **Step 3: Implement image draft behavior**

`useImageDraft` exposes `attachmentIds`, `addFiles`, `handlePaste`, `remove`, `clear`, and `error`. Preserve pasted text while extracting image files. Store each accepted image through `AttachmentService` immediately, but add message references only when the user sends.

- [ ] **Step 4: Implement accessible thumbnails and modal preview**

Each thumbnail is a real button with an image and separate remove button. Double click or Enter opens `ImagePreviewDialog`; Escape and close button dismiss it; focus returns to the invoking thumbnail. Render the dialog through a portal under the Side Panel document body.

- [ ] **Step 5: Verify image-draft components**

Run:

```bash
npm run test:run -- tests/side-panel/chat
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Confirm no component stores base64 strings in React state after Blob persistence. Do not commit.

---

### Task 3: Viewport and Region Screenshot Pipeline

**Files:**

- Create: `src/page/screenshot/screenshot-types.ts`
- Create: `src/page/screenshot/selection-geometry.ts`
- Create: `src/page/screenshot/ScreenshotOverlay.tsx`
- Create: `src/page/screenshot/mount-screenshot-overlay.tsx`
- Create: `src/platform/chrome/capture-visible-tab.ts`
- Create: `src/attachments/crop-captured-image.ts`
- Create: `src/browser/observe/visual-fallback.ts`
- Create: `src/tasks/screenshot-controller.ts`
- Modify: `src/browser/browser-controller.ts`
- Modify: `src/agent/context/agent-context.ts`
- Modify: `src/page/browser-command-handler.ts`
- Modify: `src/platform/chrome/message-router.ts`
- Create: `tests/page/screenshot/selection-geometry.test.ts`
- Create: `tests/page/screenshot/ScreenshotOverlay.test.tsx`
- Create: `tests/platform/chrome/capture-visible-tab.test.ts`
- Create: `tests/attachments/crop-captured-image.test.ts`
- Create: `tests/browser/observe/visual-fallback.test.ts`
- Create: `tests/tasks/screenshot-controller.test.ts`

**Interfaces:**

- Consumes: on-demand content script, `chrome.tabs.captureVisibleTab`, `AttachmentService`, semantic observation confidence.
- Produces: `ScreenshotController.captureViewport(tabId)`, `ScreenshotController.captureRegion(tabId)`, `VisualFallbackService.captureWhenNeeded`, `ScreenshotSelection`.

- [ ] **Step 1: Write failing geometry and overlay tests**

Cover drag in every direction, pointer leaving viewport, minimum 8×8 region, viewport resize, Escape cancellation, full-viewport button, completed region, and overlay hide/restore around capture. Visual-fallback tests must capture for a dominant canvas/image page, low target confidence after both semantic drivers, or an inconclusive verifier; they must refuse capture for an ordinary high-confidence DOM observation, a second request in the same observation generation, or an unsupported/internal page.

```ts
expect(normalizeSelection({ startX: 400, startY: 300, endX: 100, endY: 80 }, viewport)).toEqual({
  x: 100,
  y: 80,
  width: 300,
  height: 220,
});
```

- [ ] **Step 2: Write failing capture/crop/controller tests**

Mock `captureVisibleTab` and assert the requested tab still belongs to the active window. For a 200×100 source image with device scale 2, crop CSS rect `{ x: 10, y: 5, width: 20, height: 10 }` to pixel rect `{ x: 20, y: 10, width: 40, height: 20 }`. Assert the controller restores overlays after capture rejection.

- [ ] **Step 3: Run screenshot tests and confirm failure**

Run `npm run test:run -- tests/page/screenshot tests/platform/chrome/capture-visible-tab.test.ts tests/attachments/crop-captured-image.test.ts tests/browser/observe/visual-fallback.test.ts tests/tasks/screenshot-controller.test.ts`.

Expected: FAIL.

- [ ] **Step 4: Implement the page overlay**

Mount React in a closed Shadow Root attached to one extension-owned host. Draw a transparent selection rectangle and a compact control bar with `当前视口`, `完成`, and `取消`. Pointer capture owns the drag. Emit only `{ rect, devicePixelRatio, viewportWidth, viewportHeight }`; never emit page HTML.

- [ ] **Step 5: Implement capture and cropping**

Before capture, send `page.overlays.hide`, await acknowledgement, then call:

```ts
await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
```

Convert the data URL to Blob. For region capture, decode with `createImageBitmap`, draw the scaled/clamped rectangle to `OffscreenCanvas`, call `convertToBlob({ type: 'image/png' })`, and close the bitmap. For viewport capture, persist the original PNG Blob. Restore overlays in a `finally` block.

- [ ] **Step 6: Implement bounded visual fallback**

Implement visual fallback as a bounded observer capability, not a model tool. It may capture one viewport PNG per observation generation only when semantic evidence is insufficient. Store it as a transient attachment referenced by the task checkpoint, include it in the next Provider context, then release the prior transient reference when a newer checkpoint supersedes it. User-triggered viewport/region screenshots remain normal message attachments and are never auto-released with observation evidence.

Do not capture on every action, do not perform full-page stitching, and do not let a screenshot lower action-risk classification or bypass target verification.

- [ ] **Step 7: Verify screenshot pipeline**

Run:

```bash
npm run test:run -- tests/page/screenshot tests/platform/chrome/capture-visible-tab.test.ts tests/attachments/crop-captured-image.test.ts tests/browser/observe/visual-fallback.test.ts tests/tasks/screenshot-controller.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Confirm there is no scrolling capture loop, PDF generation, desktop capture, or permanent screenshot overlay. Do not commit.

---

### Task 4: Selected-Text Translate and Ask AI Bubble

**Files:**

- Create: `src/page/selection/selection-types.ts`
- Create: `src/page/selection/read-selection.ts`
- Create: `src/page/selection/SelectionBubble.tsx`
- Create: `src/page/selection/SelectionResult.tsx`
- Create: `src/page/selection/mount-selection-feature.tsx`
- Create: `src/tasks/selection-controller.ts`
- Modify: `src/page/browser-command-handler.ts`
- Modify: `src/platform/chrome/message-router.ts`
- Create: `tests/page/selection/read-selection.test.ts`
- Create: `tests/page/selection/SelectionBubble.test.tsx`
- Create: `tests/tasks/selection-controller.test.ts`

**Interfaces:**

- Consumes: page selection/range, Codex Agent Planner, active conversation.
- Produces: Translate result, Ask AI message prefill/submission, copy action.

- [ ] **Step 1: Write failing selection eligibility tests**

Test trimmed non-empty text, 8,000-character cap, password/contenteditable exclusion, collapsed ranges, selection inside extension UI, multi-line bounding rect, viewport-edge positioning, and clearing on page scroll/navigation.

- [ ] **Step 2: Write failing Translate/Ask controller tests**

Translate must create a bounded text-only model turn with the instruction to preserve meaning and output only the translation. Ask AI must add a quoted selection plus user question to the active per-tab conversation when it has no unfinished task, and must create a new per-tab conversation otherwise. Authentication failure must show a recoverable result without exposing the token.

- [ ] **Step 3: Run selection tests and confirm failure**

Run `npm run test:run -- tests/page/selection tests/tasks/selection-controller.test.ts`.

Expected: FAIL.

- [ ] **Step 4: Implement the isolated bubble UI**

Mount in the existing page Shadow Root. Show exactly two initial buttons: `翻译` and `Ask AI`. The result view shows streamed text, copy, open in Side Panel, retry, and close. The bubble anchors above the first usable range rect and flips below when necessary.

- [ ] **Step 5: Implement task integration**

Selection requests contain selection text, page URL/title, tab ID, and requested operation. Background code obtains credentials and invokes the Provider; page code receives only incremental result text and normalized errors. Ask AI opens the Side Panel after a user gesture, binds the message to the same tab, and starts a separate conversation when the current one has a non-terminal task.

- [ ] **Step 6: Verify selected-text behavior**

Run:

```bash
npm run test:run -- tests/page/selection tests/tasks/selection-controller.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Inspect page message payloads and confirm credentials, full history, and full task records never cross into the page context. Do not commit.

---

### Task 5: Page-Feature Permission and Lifecycle Integration

**Files:**

- Create: `src/platform/chrome/origin-permission.ts`
- Create: `src/page/page-feature-registry.ts`
- Modify: `src/platform/chrome/content-script-installer.ts`
- Modify: `src/platform/chrome/register-background.ts`
- Create: `tests/platform/chrome/origin-permission.test.ts`
- Create: `tests/page/page-feature-registry.test.ts`

**Interfaces:**

- Consumes: optional host permissions, content installer, screenshot and selection features.
- Produces: `OriginPermissionService`, idempotent `PageFeatureRegistry.start/stop`.

- [ ] **Step 1: Write failing permission and lifecycle tests**

Test origin normalization, HTTP/HTTPS only, denial, repeated grant, navigation to a new origin, injection exactly once per document, feature teardown on extension invalidation, and no injection into `chrome://` or Chrome Web Store pages.

- [ ] **Step 2: Run tests and confirm failure**

Run `npm run test:run -- tests/platform/chrome/origin-permission.test.ts tests/page/page-feature-registry.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement permission requests and idempotent startup**

Normalize to `${url.protocol}//${url.host}/*`. Call `chrome.permissions.request` only from a user-gesture path. The page registry uses one symbol-marked host per document and returns the existing command handler on duplicate injection. Teardown disconnects observers, ports, React roots, and object URLs.

- [ ] **Step 4: Verify the complete page-feature plan**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
git diff --check
```

Expected: all pass; manifest has optional page origins, fixed Provider origins, and no excluded media/PDF permissions. Do not commit.
