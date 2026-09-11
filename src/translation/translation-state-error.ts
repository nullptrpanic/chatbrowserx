const messages = {
  TRANSLATION_PAGE_UNAVAILABLE: 'Translation page communication is unavailable.',
  TRANSLATION_SESSION_CLOSED: 'Translation is not enabled for this session.',
  TRANSLATION_BUSY: 'Translation request limit reached.',
} as const;

/** Safe state errors must not include page data or raw Chrome exception messages. */
export class TranslationStateError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'TranslationStateError';
  }
}
