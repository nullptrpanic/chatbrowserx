import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentService, AttachmentPolicyError } from '../../attachments/attachment-service';
import type { ExistingImageUsage, ImagePolicyErrorCode } from '../../attachments/attachment-policy';
import { ObjectUrlRegistry } from '../../attachments/object-url-registry';
import type { AttachmentRecord } from '../../attachments/attachment-types';
import { IndexedDbAttachmentRepository } from '../../persistence/attachment-repository';
import { openChatBrowserDatabase } from '../../persistence/open-database';

export interface ImageDraftItem {
  readonly id: string;
  readonly record: AttachmentRecord;
  readonly previewUrl: string;
}

export interface AttachmentDraftClient {
  addFiles(
    files: readonly File[],
    source: 'file' | 'paste',
    existing: ExistingImageUsage,
  ): Promise<readonly AttachmentRecord[]>;
  get(id: string): Promise<AttachmentRecord | undefined>;
}

export interface UseImageDraftOptions {
  readonly client?: AttachmentDraftClient;
  readonly urls?: ObjectUrlRegistry;
}

export interface ImageDraftController {
  readonly items: readonly ImageDraftItem[];
  readonly attachmentIds: readonly string[];
  readonly error: ImagePolicyErrorCode | 'ATTACHMENT_FAILED' | null;
  addFiles(files: readonly File[], source?: 'file' | 'paste'): Promise<void>;
  addExisting(id: string): Promise<void>;
  handlePaste(event: Pick<ClipboardEvent, 'clipboardData'>): void;
  remove(id: string): void;
  clear(): void;
}

/** Reads image dimensions in a worker-safe browser primitive without retaining decoded pixels. */
async function readImageDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Creates the IndexedDB-backed attachment client used by the production Side Panel. */
export function createSidePanelAttachmentClient(): AttachmentDraftClient {
  const service = openChatBrowserDatabase().then((database) => {
    const repository = new IndexedDbAttachmentRepository(database);
    return {
      repository,
      service: new AttachmentService(repository, {
        clock: { now: () => Date.now() },
        ids: { create: (prefix) => `${prefix}_${crypto.randomUUID()}` },
        readDimensions: readImageDimensions,
      }),
    };
  });
  return {
    async addFiles(files, source, existing) {
      return (await service).service.addImages(files, source, existing);
    },
    async get(id) {
      return (await service).repository.get(id);
    },
  };
}

/** Owns a bounded multi-image draft while keeping only Blob-backed object URLs in UI state. */
export function useImageDraft(options: UseImageDraftOptions = {}): ImageDraftController {
  const client = useMemo(
    () => options.client ?? createSidePanelAttachmentClient(),
    [options.client],
  );
  const urls = useMemo(() => options.urls ?? new ObjectUrlRegistry(), [options.urls]);
  const seenBlobs = useRef(new WeakSet<Blob>());
  const [items, setItems] = useState<readonly ImageDraftItem[]>([]);
  const [error, setError] = useState<ImageDraftController['error']>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(
    () => () => {
      urls.releaseAll();
    },
    [urls],
  );

  /** Adds newly selected files after duplicate and complete-draft policy checks. */
  const addFiles = useCallback(
    async (files: readonly File[], source: 'file' | 'paste' = 'file'): Promise<void> => {
      const unique = files.filter((file) => !seenBlobs.current.has(file));
      if (unique.length === 0) return;
      const existing = {
        count: itemsRef.current.length,
        bytes: itemsRef.current.reduce((total, item) => total + item.record.byteSize, 0),
      };
      try {
        const records = await client.addFiles(unique, source, existing);
        for (const file of unique) seenBlobs.current.add(file);
        setItems((current) => [
          ...current,
          ...records.map((record) => ({
            id: record.id,
            record,
            previewUrl: urls.acquire(record.id, record.blob),
          })),
        ]);
        setError(null);
      } catch (caught) {
        setError(caught instanceof AttachmentPolicyError ? caught.code : 'ATTACHMENT_FAILED');
      }
    },
    [client, urls],
  );

  /** Loads an already persisted screenshot into the same bounded draft strip. */
  const addExisting = useCallback(
    async (id: string): Promise<void> => {
      if (itemsRef.current.some((item) => item.id === id)) return;
      try {
        const record = await client.get(id);
        if (record === undefined) throw new Error('Attachment is missing.');
        const nextCount = itemsRef.current.length + 1;
        const nextBytes =
          itemsRef.current.reduce((total, item) => total + item.record.byteSize, 0) +
          record.byteSize;
        if (nextCount > 8) throw new AttachmentPolicyError('TOO_MANY_IMAGES');
        if (nextBytes > 30 * 1024 * 1024) {
          throw new AttachmentPolicyError('BATCH_TOO_LARGE');
        }
        setItems((current) => [
          ...current,
          { id: record.id, record, previewUrl: urls.acquire(record.id, record.blob) },
        ]);
        setError(null);
      } catch (caught) {
        setError(caught instanceof AttachmentPolicyError ? caught.code : 'ATTACHMENT_FAILED');
      }
    },
    [client, urls],
  );

  /** Extracts image File items from a paste while leaving pasted text behavior untouched. */
  const handlePaste = useCallback(
    (event: Pick<ClipboardEvent, 'clipboardData'>): void => {
      const files = [...(event.clipboardData?.items ?? [])].flatMap((item) => {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) return [];
        const file = item.getAsFile();
        return file === null ? [] : [file];
      });
      if (files.length > 0) void addFiles(files, 'paste');
    },
    [addFiles],
  );

  /** Removes one draft image and releases its local preview URL immediately. */
  const remove = useCallback(
    (id: string): void => {
      setItems((current) => {
        if (!current.some((item) => item.id === id)) return current;
        urls.release(id);
        return current.filter((item) => item.id !== id);
      });
    },
    [urls],
  );

  /** Clears every draft item and revokes all preview URLs without deleting durable Blobs. */
  const clear = useCallback((): void => {
    urls.releaseAll();
    setItems([]);
    setError(null);
  }, [urls]);

  return {
    items,
    attachmentIds: items.map((item) => item.id),
    error,
    addFiles,
    addExisting,
    handlePaste,
    remove,
    clear,
  };
}
