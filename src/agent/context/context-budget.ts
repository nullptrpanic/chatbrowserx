import { IMAGE_POLICY } from '../../attachments/attachment-policy';

export const MAX_OBSERVATION_CHARACTERS = 24_000;
export const MAX_RECENT_CONVERSATION_CHARACTERS = 32_000;
export const MAX_COMPLETED_TOOL_OUTPUT_CHARACTERS = 64_000;
export const MAX_MODEL_IMAGE_BYTES = IMAGE_POLICY.maxBytesPerImage;
export const MAX_MODEL_IMAGE_TOTAL_BYTES = IMAGE_POLICY.maxBytesPerMessage;
export const MAX_MODEL_IMAGE_COUNT = IMAGE_POLICY.maxCount;
