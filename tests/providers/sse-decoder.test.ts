import { describe, expect, it } from 'vitest';
import type { ProviderError } from '../../src/providers/provider-errors';
import { decodeSseStream, type DecodedSseEvent } from '../../src/providers/sse-decoder';

/** Creates a byte stream whose boundaries are controlled by the test. */
function streamFromBytes(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/** Splits encoded data at absolute byte offsets. */
function splitBytes(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const offset of offsets) {
    chunks.push(bytes.slice(start, offset));
    start = offset;
  }
  chunks.push(bytes.slice(start));
  return chunks;
}

/** Collects an async iterable into an array. */
async function collect(iterable: AsyncIterable<DecodedSseEvent>): Promise<DecodedSseEvent[]> {
  const values: DecodedSseEvent[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('decodeSseStream', () => {
  it('decodes fragmented fields, JSON, event boundaries, and UTF-8 code points', async () => {
    const source =
      'event: response.output_text.delta\ndata: {"delta":"你好"}\n\n' +
      'event: response.completed\ndata: {"response":{"id":"r1"}}\n\n';
    const encoded = new TextEncoder().encode(source);
    const chineseStart = encoded.findIndex((byte) => byte === 0xe4);
    const chunks = splitBytes(encoded, [
      2,
      9,
      chineseStart + 1,
      chineseStart + 4,
      encoded.length - 1,
    ]);

    await expect(collect(decodeSseStream(streamFromBytes(chunks)))).resolves.toEqual([
      { event: 'response.output_text.delta', data: { delta: '你好' } },
      { event: 'response.completed', data: { response: { id: 'r1' } } },
    ]);
  });

  it('supports comments, repeated data fields, CRLF, LF, and a split CRLF boundary', async () => {
    const first = new TextEncoder().encode(
      ': keep-alive\r\nevent: custom\r\ndata: {"first":1,\r\ndata: "second":2}\r',
    );
    const second = new TextEncoder().encode('\n\r\nevent: message\ndata: {"ignored":true}\n\n');

    await expect(collect(decodeSseStream(streamFromBytes([first, second])))).resolves.toEqual([
      { event: 'custom', data: { first: 1, second: 2 } },
      { event: 'message', data: { ignored: true } },
    ]);
  });

  it('flushes an unterminated final event at EOF', async () => {
    const bytes = new TextEncoder().encode(
      'event: response.created\ndata: {"response":{"id":"r1"}}',
    );

    await expect(collect(decodeSseStream(streamFromBytes([bytes])))).resolves.toEqual([
      { event: 'response.created', data: { response: { id: 'r1' } } },
    ]);
  });

  it('stops at the done sentinel', async () => {
    const bytes = new TextEncoder().encode(
      'event: response.created\ndata: {"response":{"id":"r1"}}\n\n' +
        'data: [DONE]\n\n' +
        'event: response.completed\ndata: {"response":{"id":"late"}}\n\n',
    );

    await expect(collect(decodeSseStream(streamFromBytes([bytes])))).resolves.toEqual([
      { event: 'response.created', data: { response: { id: 'r1' } } },
    ]);
  });

  it('preserves an upstream error event for the provider translator', async () => {
    const bytes = new TextEncoder().encode(
      'event: error\ndata: {"type":"server_error","message":"temporary"}\n\n',
    );

    await expect(collect(decodeSseStream(streamFromBytes([bytes])))).resolves.toEqual([
      { event: 'error', data: { type: 'server_error', message: 'temporary' } },
    ]);
  });

  it('rejects invalid JSON as an invalid provider response', async () => {
    const bytes = new TextEncoder().encode('event: response.created\ndata: {broken}\n\n');

    await expect(collect(decodeSseStream(streamFromBytes([bytes])))).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'INVALID_RESPONSE',
      retryable: false,
      invalidResponseStage: 'sse_decode',
    } satisfies Partial<ProviderError>);
  });

  it('rejects an event larger than one MiB', async () => {
    const oversized = `data: {"value":"${'x'.repeat(1024 * 1024)}"}\n\n`;

    await expect(
      collect(decodeSseStream(streamFromBytes([new TextEncoder().encode(oversized)]))),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'INVALID_RESPONSE',
      invalidResponseStage: 'sse_decode',
    } satisfies Partial<ProviderError>);
  });

  it('cancels and rejects a stream that stays idle past the configured timeout', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    await expect(collect(decodeSseStream(stream, { idleTimeoutMs: 5 }))).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'TRANSIENT',
      retryable: true,
    } satisfies Partial<ProviderError>);
    expect(cancelled).toBe(true);
  });
});
