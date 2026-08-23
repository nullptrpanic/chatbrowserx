import type {
  ModelFunctionOutput,
  ModelInputItem,
  ModelMessageContent,
} from '../../providers/provider-types';

const ITEM_OVERHEAD_TOKENS = 12;
const ORIGINAL_IMAGE_TOKENS = 4_096;
const LOW_DETAIL_IMAGE_TOKENS = 1_024;

/** Conservatively estimates ordinary text without serializing an image data URL. */
function textTokens(value: string): number {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;
  for (let index = 0; index < value.length; index += 1) {
    if ((value.charCodeAt(index) ?? 0) <= 0x7f) asciiCharacters += 1;
    else nonAsciiCharacters += 1;
  }
  return Math.ceil(asciiCharacters / 3) + nonAsciiCharacters;
}

function contentTokens(content: ModelMessageContent): number {
  if (content.type === 'input_image') {
    return content.detail === 'low' || content.detail === 'auto'
      ? LOW_DETAIL_IMAGE_TOKENS
      : ORIGINAL_IMAGE_TOKENS;
  }
  return textTokens(content.text);
}

function outputTokens(output: ModelFunctionOutput): number {
  return typeof output === 'string'
    ? textTokens(output)
    : output.reduce((total, content) => total + contentTokens(content), 0);
}

function itemTokens(item: ModelInputItem): number {
  switch (item.type) {
    case 'message':
      return (
        ITEM_OVERHEAD_TOKENS +
        item.content.reduce((total, content) => total + contentTokens(content), 0)
      );
    case 'reasoning':
      return (
        ITEM_OVERHEAD_TOKENS +
        Math.ceil(item.encryptedContent.length / 2) +
        item.summary.reduce((total, summary) => total + textTokens(summary.text), 0)
      );
    case 'function_call':
      return (
        ITEM_OVERHEAD_TOKENS +
        textTokens(item.callId) +
        textTokens(item.name) +
        textTokens(item.argumentsJson)
      );
    case 'function_call_output':
      return ITEM_OVERHEAD_TOKENS + textTokens(item.callId) + outputTokens(item.output);
    case 'compaction':
      return (
        ITEM_OVERHEAD_TOKENS + textTokens(item.itemId) + Math.ceil(item.encryptedContent.length / 2)
      );
  }
}

/**
 * Estimates only the suffix generated after the last measured Provider request.
 *
 * The latest completed call was produced by that request, so its adjacent assistant/reasoning
 * output, the call/result pair, and later supplements have not contributed to the stored input
 * usage yet. Older context is deliberately excluded because the Provider already measured it.
 */
export function estimateUnmeasuredContextTokens(
  activeInput: readonly ModelInputItem[],
  latestCompletedCallId: string | undefined,
): number {
  if (latestCompletedCallId === undefined) return 0;
  const callIndex = activeInput.findLastIndex(
    (item) => item.type === 'function_call' && item.callId === latestCompletedCallId,
  );
  if (callIndex < 0) return 0;

  let startIndex = callIndex;
  while (startIndex > 0) {
    const previous = activeInput[startIndex - 1];
    if (
      previous?.type !== 'reasoning' &&
      !(previous?.type === 'message' && previous.role === 'assistant')
    ) {
      break;
    }
    startIndex -= 1;
  }

  return activeInput.slice(startIndex).reduce((total, item) => total + itemTokens(item), 0);
}
