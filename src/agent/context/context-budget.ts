import { IMAGE_POLICY } from '../../attachments/attachment-policy';

export const MAX_MODEL_IMAGE_BYTES = IMAGE_POLICY.maxBytesPerImage;
export const MAX_MODEL_IMAGE_TOTAL_BYTES = IMAGE_POLICY.maxBytesPerMessage;
export const MAX_MODEL_IMAGE_COUNT = IMAGE_POLICY.maxCount;
export const MAX_MODEL_HISTORY_TEXT_CHARACTERS = 40_000;
export const MAX_MODEL_REPLY_TEXT_CHARACTERS = 4_000;
