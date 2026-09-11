import type { ExtensionMessage, ExtensionResponse } from '../../src/shared/protocol/message-types';

/** Fake screenshot boundary for DOM-only tests; pixel extraction has separate bitmap tests. */
export function inspectionFixture(
  message: ExtensionMessage,
  fingerprint = 'unchanged',
): ExtensionResponse {
  if (message.type !== 'translation.inspect') throw new Error('Expected inspection.');
  const r = message.payload.rect;
  const tiles = [];
  for (let row = Math.floor(r.y / 64) * 64; row < r.y + r.height; row += 64) {
    for (let col = Math.floor(r.x / 64) * 64; col < r.x + r.width; col += 64) {
      const x = Math.max(col, r.x),
        y = Math.max(row, r.y);
      tiles.push({
        rect: {
          x,
          y,
          width: Math.min(col + 64, r.x + r.width) - x,
          height: Math.min(row + 64, r.y + r.height) - y,
        },
        fingerprint,
      });
    }
  }
  return { version: 1, requestId: message.requestId, ok: true, data: { tiles } };
}
