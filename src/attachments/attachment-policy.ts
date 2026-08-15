export const IMAGE_POLICY = Object.freeze({
  acceptedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
  maxCount: 8,
  maxBytesPerImage: 10 * 1024 * 1024,
  maxBytesPerMessage: 30 * 1024 * 1024,
});

export type ImagePolicyErrorCode =
  'EMPTY_IMAGE' | 'UNSUPPORTED_TYPE' | 'IMAGE_TOO_LARGE' | 'TOO_MANY_IMAGES' | 'BATCH_TOO_LARGE';

export interface ExistingImageUsage {
  readonly count: number;
  readonly bytes: number;
}

export type ImageBatchValidation =
  | { readonly ok: true; readonly files: readonly File[] }
  | { readonly ok: false; readonly code: ImagePolicyErrorCode; readonly index: number | null };

const acceptedMimeTypes = new Set<string>(IMAGE_POLICY.acceptedMimeTypes);

/** Validates one additive image batch against per-file and complete-message limits. */
export function validateImageBatch(
  files: readonly File[],
  existing: ExistingImageUsage = { count: 0, bytes: 0 },
): ImageBatchValidation {
  if (existing.count + files.length > IMAGE_POLICY.maxCount) {
    return { ok: false, code: 'TOO_MANY_IMAGES', index: null };
  }

  let totalBytes = Math.max(0, existing.bytes);
  for (const [index, file] of files.entries()) {
    if (file.size <= 0) return { ok: false, code: 'EMPTY_IMAGE', index };
    if (!acceptedMimeTypes.has(file.type)) {
      return { ok: false, code: 'UNSUPPORTED_TYPE', index };
    }
    if (file.size > IMAGE_POLICY.maxBytesPerImage) {
      return { ok: false, code: 'IMAGE_TOO_LARGE', index };
    }
    totalBytes += file.size;
  }

  if (totalBytes > IMAGE_POLICY.maxBytesPerMessage) {
    return { ok: false, code: 'BATCH_TOO_LARGE', index: null };
  }
  return { ok: true, files };
}
