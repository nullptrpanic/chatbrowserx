import type { Page } from '@playwright/test';
import type {
  ExtensionMessage,
  ExtensionResponse,
} from '../../../src/shared/protocol/message-types';

/** Sends one real extension runtime message and validates its complete response envelope. */
export async function sendExtensionMessage<TData>(
  page: Page,
  message: ExtensionMessage,
): Promise<TData> {
  const response = await page.evaluate(
    async (request) => chrome.runtime.sendMessage(request),
    message,
  );
  if (
    typeof response !== 'object' ||
    response === null ||
    response.version !== 1 ||
    response.requestId !== message.requestId ||
    typeof response.ok !== 'boolean'
  ) {
    throw new Error(`${message.type} returned an invalid extension response.`);
  }
  const envelope = response as ExtensionResponse<TData>;
  if (!envelope.ok) throw new Error(`${message.type} failed with ${envelope.error.code}.`);
  return envelope.data;
}
