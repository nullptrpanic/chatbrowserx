import { providerErrorFromCode } from './provider-errors';

const MAX_EVENT_BYTES = 1024 * 1024;

export interface DecodedSseEvent {
  readonly event: string;
  readonly data: unknown;
}

interface PendingEvent {
  event: string;
  dataLines: string[];
  completedLineBytes: number;
}

interface ParsedLine {
  readonly line: string;
  readonly consumedCharacters: number;
}

/** Removes at most one optional space after an SSE field separator. */
function fieldValue(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value;
}

/** Reads one line while retaining a trailing CR that may be half of a split CRLF. */
function readLine(buffer: string, flush: boolean): ParsedLine | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character === '\n') {
      return { line: buffer.slice(0, index), consumedCharacters: index + 1 };
    }
    if (character !== '\r') {
      continue;
    }
    if (index + 1 === buffer.length && !flush) {
      return null;
    }
    const hasLineFeed = buffer[index + 1] === '\n';
    return {
      line: buffer.slice(0, index),
      consumedCharacters: index + (hasLineFeed ? 2 : 1),
    };
  }

  if (flush && buffer.length > 0) {
    return { line: buffer, consumedCharacters: buffer.length };
  }
  return null;
}

/** Parses one complete SSE field line into the pending event. */
function applyLine(pending: PendingEvent, line: string): void {
  if (line.startsWith(':')) {
    return;
  }

  const separatorIndex = line.indexOf(':');
  const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
  const value = separatorIndex === -1 ? '' : fieldValue(line.slice(separatorIndex + 1));

  if (field === 'event') {
    pending.event = value;
  } else if (field === 'data') {
    pending.dataLines.push(value);
  }
}

/** Parses a complete pending event or returns null for an event without data. */
function finishEvent(pending: PendingEvent): DecodedSseEvent | 'done' | null {
  if (pending.dataLines.length === 0) {
    return null;
  }

  const source = pending.dataLines.join('\n');
  if (source.trim() === '[DONE]') {
    return 'done';
  }

  try {
    return {
      event: pending.event || 'message',
      data: JSON.parse(source) as unknown,
    };
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}

/** Resets mutable event state without reallocating the parser container. */
function resetEvent(pending: PendingEvent): void {
  pending.event = '';
  pending.dataLines = [];
  pending.completedLineBytes = 0;
}

/** Enforces the per-event memory boundary against complete and partial SSE lines. */
function assertEventSize(pending: PendingEvent, lineBuffer: string, encoder: TextEncoder): void {
  const partialLineBytes = encoder.encode(lineBuffer).byteLength;
  if (pending.completedLineBytes + partialLineBytes > MAX_EVENT_BYTES) {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}

/** Decodes a streaming HTTP SSE body into parsed JSON events. */
export async function* decodeSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<DecodedSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending: PendingEvent = { event: '', dataLines: [], completedLineBytes: 0 };
  let lineBuffer = '';
  let reachedDone = false;

  try {
    while (!reachedDone) {
      const read = await reader.read();
      lineBuffer += decoder.decode(read.value, { stream: !read.done });
      assertEventSize(pending, lineBuffer, encoder);

      let parsedLine = readLine(lineBuffer, read.done);
      while (parsedLine !== null) {
        lineBuffer = lineBuffer.slice(parsedLine.consumedCharacters);
        pending.completedLineBytes += encoder.encode(parsedLine.line).byteLength + 1;
        assertEventSize(pending, lineBuffer, encoder);

        if (parsedLine.line.length === 0) {
          const event = finishEvent(pending);
          resetEvent(pending);
          if (event === 'done') {
            reachedDone = true;
            break;
          }
          if (event !== null) {
            yield event;
          }
        } else {
          applyLine(pending, parsedLine.line);
        }

        parsedLine = readLine(lineBuffer, read.done);
      }

      if (read.done) {
        const event = finishEvent(pending);
        resetEvent(pending);
        if (event !== null && event !== 'done') {
          yield event;
        }
        break;
      }
    }
  } finally {
    if (reachedDone) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
