import { providerErrorFromCode } from '../provider-errors';

const WIRE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Validates one provider-neutral tool name against the Codex wire grammar. */
export function toCodexToolName(name: string): string {
  if (WIRE_TOOL_NAME_PATTERN.test(name)) return name;
  throw providerErrorFromCode('INVALID_RESPONSE');
}

/** Validates one streamed Codex tool name before exposing it through the generic interface. */
export function fromCodexToolName(name: string): string {
  if (WIRE_TOOL_NAME_PATTERN.test(name)) return name;
  throw providerErrorFromCode('INVALID_RESPONSE');
}
