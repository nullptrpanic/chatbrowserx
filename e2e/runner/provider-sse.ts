import { jsonRecord } from './json-contract';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_TYPES = 32;
const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,128}$/u;

export interface ProviderSseSummary {
  readonly bodyBytes: number;
  readonly bodyTooLarge: boolean;
  readonly completed: boolean;
  readonly failed: boolean;
  readonly eventTypes: readonly string[];
  readonly encryptedReasoningOutputCount: number;
  readonly errorCodes: readonly string[];
  readonly errorTypes: readonly string[];
  readonly captureError: string | null;
}

function safeLabel(value: unknown): string | null {
  return typeof value === 'string' && SAFE_LABEL.test(value) ? value : null;
}

/** Extracts bounded structural lifecycle evidence without retaining Provider response text. */
export function summarizeProviderSse(body: Buffer, status: number | null): ProviderSseSummary {
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    return {
      bodyBytes: body.byteLength,
      bodyTooLarge: true,
      completed: false,
      failed: status !== null && status >= 400,
      eventTypes: [],
      encryptedReasoningOutputCount: 0,
      errorCodes: [],
      errorTypes: [],
      captureError: 'response_body_exceeded_capture_limit',
    };
  }

  const eventTypes = new Set<string>();
  const reasoningItems = new Set<string>();
  const errorCodes = new Set<string>();
  const errorTypes = new Set<string>();
  let completed = false;
  let failed = status !== null && status >= 400;
  for (const line of body.toString('utf8').split(/\r?\n/u)) {
    if (line.startsWith('event:')) {
      const eventType = line.slice('event:'.length).trim();
      if (eventType.length > 0 && eventTypes.size < MAX_EVENT_TYPES) eventTypes.add(eventType);
      completed ||= eventType === 'response.completed';
      failed ||= eventType === 'response.failed' || eventType === 'error';
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const serialized = line.slice('data:'.length).trim();
    if (serialized.length === 0 || serialized === '[DONE]') continue;
    try {
      const payload = jsonRecord(JSON.parse(serialized));
      const eventType = safeLabel(payload?.type);
      if (eventType !== null && eventTypes.size < MAX_EVENT_TYPES) eventTypes.add(eventType);
      completed ||= eventType === 'response.completed';
      failed ||= eventType === 'response.failed' || eventType === 'error';
      const item = jsonRecord(payload?.item);
      if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string') {
        reasoningItems.add(safeLabel(item.id) ?? `reasoning_${String(reasoningItems.size + 1)}`);
      }
      const response = jsonRecord(payload?.response);
      for (const error of [jsonRecord(payload?.error), jsonRecord(response?.error)]) {
        const code = safeLabel(error?.code);
        const type = safeLabel(error?.type);
        if (code !== null) errorCodes.add(code);
        if (type !== null) errorTypes.add(type);
      }
    } catch {
      // Malformed payload text is intentionally discarded.
    }
  }
  return {
    bodyBytes: body.byteLength,
    bodyTooLarge: false,
    completed,
    failed,
    eventTypes: [...eventTypes],
    encryptedReasoningOutputCount: reasoningItems.size,
    errorCodes: [...errorCodes],
    errorTypes: [...errorTypes],
    captureError: null,
  };
}
