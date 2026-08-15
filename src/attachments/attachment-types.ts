import type { AttachmentId } from '../shared/ids';

export type AttachmentSource =
  'paste' | 'file' | 'viewport_capture' | 'region_capture' | 'visual_fallback';

export interface NewAttachment {
  readonly id: AttachmentId;
  readonly blob: Blob;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly source: AttachmentSource;
  readonly createdAt: number;
  readonly fileName?: string;
}

export type AttachmentRecord = NewAttachment;

export interface AttachmentReference {
  readonly attachmentId: AttachmentId;
  readonly referenceId: string;
}
