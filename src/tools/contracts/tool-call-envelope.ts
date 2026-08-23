const MAX_TOOL_CALL_ID_CHARACTERS = 256;
const MAX_TOOL_ARGUMENTS_JSON_CHARACTERS = 32 * 1_024;

export interface ModelToolCallSource {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

/** Parses the common bounded envelope before family-specific schema validation. */
export function parseToolCallArguments(input: ModelToolCallSource): unknown {
  try {
    if (
      input.callId.trim().length === 0 ||
      input.callId.length > MAX_TOOL_CALL_ID_CHARACTERS ||
      input.argumentsJson.length > MAX_TOOL_ARGUMENTS_JSON_CHARACTERS
    ) {
      throw new Error('invalid');
    }
    return JSON.parse(input.argumentsJson) as unknown;
  } catch {
    throw new Error('Tool call envelope is invalid.');
  }
}
