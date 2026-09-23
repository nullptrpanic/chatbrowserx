/** Text-free transport metadata for the native translation diagnostic. */
export type TranslationRequestState = {
  status?: number;
  finished?: boolean;
  transportFailed?: boolean;
};

type DiagnosticResponse = {
  status(): number;
  finished(): Promise<Error | null>;
};

export async function observeTranslationRequest(
  response: Promise<DiagnosticResponse | null>,
  record: TranslationRequestState,
  failed?: Promise<never>,
): Promise<void> {
  try {
    const result = await (failed ? Promise.race([response, failed]) : response);
    if (result) record.status = result.status();
    // The product classifies non-2xx responses at the headers and cancels their
    // untrusted body. Playwright may never finish that canceled body; this is an
    // observed HTTP failure, not an in-flight successful translation stream.
    const httpFailure = result && (result.status() < 200 || result.status() >= 300);
    // Playwright emits requestfailed for an aborted 2xx stream without resolving
    // Response.finished(). Observe the failure of this exact request as well.
    record.transportFailed =
      !result ||
      (!httpFailure &&
        (await (failed ? Promise.race([result.finished(), failed]) : result.finished())) !== null);
    record.finished = true;
  } catch {
    record.transportFailed = true;
    record.finished = true;
  }
}
