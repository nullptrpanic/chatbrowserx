import { extensionMessageSchema, pageCommandSchema } from './message-schema';
import type { ExtensionMessage, PageCommand } from './message-types';

/**
 * Formats only validation paths so untrusted message values never enter an error string.
 */
function formatInvalidPaths(issues: readonly { readonly path: PropertyKey[] }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => issue.path.join('.') || 'message')
    .join(', ');
}

/**
 * Validates an untrusted runtime message without including its payload values in validation errors.
 */
export function parseExtensionMessage(value: unknown): ExtensionMessage {
  const result = extensionMessageSchema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const invalidPaths = formatInvalidPaths(result.error.issues);

  throw new Error(`Invalid extension message: ${invalidPaths}`);
}

/**
 * Validates an untrusted content-script command against the credential-free page union.
 */
export function parsePageCommand(value: unknown): PageCommand {
  const result = pageCommandSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw new Error(`Invalid page command: ${formatInvalidPaths(result.error.issues)}`);
}
