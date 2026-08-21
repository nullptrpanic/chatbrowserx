export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses' as const;
export const CODEX_COMPACT_URL = 'https://chatgpt.com/backend-api/codex/responses/compact' as const;
export const CODEX_MODEL = 'gpt-5.6-terra' as const;
/** Codex reserves five percent of this model's declared 272k context as a safety margin. */
export const CODEX_EFFECTIVE_CONTEXT_WINDOW_TOKENS = 258_400;
