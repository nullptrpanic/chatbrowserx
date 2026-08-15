import type { ConversationRepository } from '../persistence/conversation-repository';
import type { Clock } from '../shared/time';
import type { MessageRecord, MessageStatus } from '../tasks/message-types';

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BYTES = 8 * 1024;

export class StreamPersistenceBuffer {
  readonly #repository: Pick<ConversationRepository, 'updateMessage'>;
  readonly #clock: Clock;
  readonly #encoder = new TextEncoder();
  #message: MessageRecord;
  #pendingBytes = 0;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writes: Promise<void> = Promise.resolve();
  #writeFailure: unknown = null;

  /** Creates a one-second/eight-KiB persistence buffer for one streaming assistant message. */
  constructor(
    repository: Pick<ConversationRepository, 'updateMessage'>,
    message: MessageRecord,
    clock: Clock,
  ) {
    if (message.role !== 'assistant' || message.status !== 'streaming') {
      throw new Error('Stream persistence requires a streaming assistant message.');
    }
    this.#repository = repository;
    this.#message = message;
    this.#clock = clock;
  }

  /** Appends text in memory and flushes when the byte threshold is reached. */
  async append(delta: string): Promise<void> {
    this.#throwWriteFailure();
    if (this.#message.status !== 'streaming') {
      throw new Error('Cannot append to a completed model stream.');
    }
    if (delta.length === 0) return;
    this.#message = { ...this.#message, text: `${this.#message.text}${delta}` };
    this.#pendingBytes += this.#encoder.encode(delta).byteLength;
    this.#dirty = true;
    if (this.#pendingBytes >= FLUSH_BYTES) {
      await this.#flush();
      return;
    }
    this.#schedule();
  }

  /** Forces all pending text and the complete status into durable storage. */
  async complete(): Promise<void> {
    await this.#finalize('complete');
  }

  /** Forces all pending text and the interrupted status into durable storage. */
  async interrupt(): Promise<void> {
    await this.#finalize('interrupted');
  }

  /** Forces all pending text and the error status into durable storage. */
  async fail(): Promise<void> {
    await this.#finalize('error');
  }

  /** Schedules one timer for the oldest pending text batch. */
  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flush().catch(() => undefined);
    }, FLUSH_INTERVAL_MS);
  }

  /** Cancels a pending timer before an immediate or terminal flush. */
  #cancelTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Enqueues one immutable durable snapshot without allowing writes to reorder. */
  #persist(snapshot: MessageRecord): Promise<void> {
    const write = this.#writes.then(() => this.#repository.updateMessage(snapshot));
    this.#writes = write.catch((error: unknown) => {
      this.#writeFailure ??= error;
    });
    return write;
  }

  /** Flushes dirty text while keeping the message in streaming state. */
  async #flush(): Promise<void> {
    this.#throwWriteFailure();
    if (!this.#dirty) return this.#writes;
    this.#cancelTimer();
    this.#dirty = false;
    this.#pendingBytes = 0;
    this.#message = {
      ...this.#message,
      updatedAt: Math.max(this.#message.updatedAt, this.#clock.now()),
    };
    await this.#persist({ ...this.#message });
  }

  /** Applies one terminal status exactly once and waits for all prior writes. */
  async #finalize(
    status: Extract<MessageStatus, 'complete' | 'interrupted' | 'error'>,
  ): Promise<void> {
    this.#throwWriteFailure();
    if (this.#message.status === status) {
      await this.#writes;
      this.#throwWriteFailure();
      return;
    }
    if (this.#message.status !== 'streaming') {
      throw new Error('Model stream is already finalized.');
    }
    this.#cancelTimer();
    this.#dirty = false;
    this.#pendingBytes = 0;
    this.#message = {
      ...this.#message,
      status,
      updatedAt: Math.max(this.#message.updatedAt, this.#clock.now()),
    };
    await this.#persist({ ...this.#message });
    this.#throwWriteFailure();
  }

  /** Rethrows a prior asynchronous persistence failure before accepting more model output. */
  #throwWriteFailure(): void {
    if (this.#writeFailure !== null) {
      throw this.#writeFailure;
    }
  }
}
