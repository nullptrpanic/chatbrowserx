import { IMAGE_POLICY } from '../../attachments/attachment-policy';
import type { AttachmentRecord } from '../../attachments/attachment-types';
import type { AttachmentDraftClient } from './use-image-draft';

interface CopyMessageInput {
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly client: Pick<AttachmentDraftClient, 'get'>;
}

const supportedImageTypes = new Set<string>(IMAGE_POLICY.acceptedMimeTypes);

/** Escapes message content before placing it in the rich clipboard representation. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}

/** Materializes one already-bounded stored image as a portable clipboard data URL. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Image data could not be encoded for the clipboard.'));
    });
    reader.addEventListener('error', () => reject(new Error('Image data could not be read.')));
    reader.readAsDataURL(blob);
  });
}

/** Loads only supported image records while preserving the message attachment order. */
async function loadImages(input: CopyMessageInput): Promise<readonly AttachmentRecord[]> {
  const records = await Promise.all(input.attachmentIds.map((id) => input.client.get(id)));
  return records.filter(
    (record): record is AttachmentRecord =>
      record !== undefined && supportedImageTypes.has(record.mimeType),
  );
}

/** Builds a self-contained rich fragment that can cross the extension/application boundary. */
async function buildRichHtml(text: string, images: readonly AttachmentRecord[]): Promise<string> {
  const imageUrls = await Promise.all(images.map((image) => blobToDataUrl(image.blob)));
  const textBlock = text.length === 0 ? '' : `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`;
  const imageBlocks = images
    .map(
      (image, index) =>
        `<p><img src="${imageUrls[index] ?? ''}" alt="${escapeHtml(image.fileName ?? 'Image')}" /></p>`,
    )
    .join('');
  return `<div>${textBlock}${imageBlocks}</div>`;
}

/** Copies one message to the system clipboard with portable plain-text and rich representations. */
export async function copyMessageToClipboard(input: CopyMessageInput): Promise<void> {
  if (
    input.attachmentIds.length === 0 ||
    typeof ClipboardItem === 'undefined' ||
    typeof navigator.clipboard.write !== 'function'
  ) {
    await navigator.clipboard.writeText(input.text);
    return;
  }

  const images = await loadImages(input);
  if (images.length === 0) {
    await navigator.clipboard.writeText(input.text);
    return;
  }

  const html = await buildRichHtml(input.text, images);
  try {
    await navigator.clipboard.write([
      new ClipboardItem(
        {
          'text/plain': new Blob([input.text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        },
        { presentationStyle: 'inline' },
      ),
    ]);
  } catch {
    await navigator.clipboard.writeText(input.text);
  }
}
