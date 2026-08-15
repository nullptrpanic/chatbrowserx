import type { AttachmentSource, AttachmentRecord } from './attachment-types';
import type { AttachmentRepository } from '../persistence/attachment-repository';
import type { AttachmentId, IdGenerator } from '../shared/ids';
import type { Clock } from '../shared/time';
import {
  validateImageBatch,
  type ExistingImageUsage,
  type ImagePolicyErrorCode,
} from './attachment-policy';

export class AttachmentPolicyError extends Error {
  readonly code: ImagePolicyErrorCode;

  /** Creates a stable attachment validation error without retaining file content or paths. */
  constructor(code: ImagePolicyErrorCode) {
    super('Image attachment does not satisfy the configured policy.');
    this.name = 'AttachmentPolicyError';
    this.code = code;
  }
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface AttachmentServiceDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly readDimensions?: (blob: Blob) => Promise<ImageDimensions | null>;
}

/** Removes directory components, control characters, and excessive display-name length. */
function safeFileName(value: string): string | undefined {
  const leaf = value
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  return leaf === undefined || leaf.length === 0 ? undefined : leaf.slice(0, 255);
}

export class AttachmentService {
  readonly #repository: AttachmentRepository;
  readonly #dependencies: AttachmentServiceDependencies;

  /** Creates the validated image persistence boundary over one attachment repository. */
  constructor(repository: AttachmentRepository, dependencies: AttachmentServiceDependencies) {
    this.#repository = repository;
    this.#dependencies = dependencies;
  }

  /** Validates and stores each image Blob once while returning durable attachment records. */
  async addImages(
    files: readonly File[],
    source: AttachmentSource,
    existing?: ExistingImageUsage,
  ): Promise<readonly AttachmentRecord[]> {
    const validation = validateImageBatch(files, existing);
    if (!validation.ok) throw new AttachmentPolicyError(validation.code);

    const records: AttachmentRecord[] = [];
    for (const file of validation.files) {
      records.push(await this.#persist(file, source, safeFileName(file.name)));
    }
    return records;
  }

  /** Validates and stores one captured or generated image Blob without creating a second copy. */
  async addImageBlob(blob: Blob, source: AttachmentSource): Promise<AttachmentRecord> {
    const validation = validateImageBatch([blob as File]);
    if (!validation.ok) throw new AttachmentPolicyError(validation.code);
    return this.#persist(blob, source);
  }

  /** Adds one explicit owner reference after an image becomes part of durable user state. */
  addReference(id: AttachmentId, referenceId: string): Promise<void> {
    return this.#repository.addReference(id, referenceId);
  }

  /** Removes one owner reference while leaving garbage collection to the repository policy. */
  removeReference(id: AttachmentId, referenceId: string): Promise<void> {
    return this.#repository.removeReference(id, referenceId);
  }

  /** Builds and stores one normalized attachment record around its original Blob instance. */
  async #persist(
    blob: Blob,
    source: AttachmentSource,
    fileName?: string,
  ): Promise<AttachmentRecord> {
    const dimensions = await this.#dependencies.readDimensions?.(blob).catch(() => null);
    return this.#repository.put({
      id: this.#createId(),
      blob,
      mimeType: blob.type,
      byteSize: blob.size,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      source,
      createdAt: this.#dependencies.clock.now(),
      ...(fileName === undefined ? {} : { fileName }),
    });
  }

  /** Requests a nonblank attachment identifier from the injected generator. */
  #createId(): AttachmentId {
    const id = this.#dependencies.ids.create('attachment').trim();
    if (id.length === 0) throw new Error('Attachment identifier generation failed.');
    return id;
  }
}
