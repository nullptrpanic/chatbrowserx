import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AttachmentService, AttachmentPolicyError } from '../../attachments/attachment-service';
import {
  validateImageBatch,
  type ExistingImageUsage,
  type ImagePolicyErrorCode,
} from '../../attachments/attachment-policy';
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
  remove(...ids: string[]): void;
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

interface ImageDraft {
  items: readonly ImageDraftItem[];
  pending: Promise<void>;
}

function emptyDraft(): ImageDraft {
  return { items: [], pending: Promise.resolve() };
}

/** Owns a bounded multi-image draft while keeping only Blob-backed object URLs in UI state. */
export function useImageDraft(options: UseImageDraftOptions = {}): ImageDraftController {
  const client = useMemo(
    () => options.client ?? createSidePanelAttachmentClient(),
    [options.client],
  );
  const urls = useMemo(() => options.urls ?? new ObjectUrlRegistry(), [options.urls]);
  const active = useRef<ImageDraft | null>(null);
  const [items, setItems] = useState<readonly ImageDraftItem[]>([]);
  const [error, setError] = useState<ImageDraftController['error']>(null);
  useLayoutEffect(() => {
    active.current = emptyDraft();
    return () => {
      active.current = null;
      urls.releaseAll();
    };
  }, [urls]);

  // File reads and screenshot lookups share one quota and may outlive their draft.
  const append = useCallback(
    (
      load: (draft: ImageDraft, usage: ExistingImageUsage) => Promise<readonly AttachmentRecord[]>,
    ) => {
      const draft = active.current;
      if (!draft) return Promise.resolve();
      draft.pending = draft.pending.then(async () => {
        if (active.current !== draft) return;
        try {
          const records = await load(draft, {
            count: draft.items.length,
            bytes: draft.items.reduce((total, item) => total + item.record.byteSize, 0),
          });
          if (active.current !== draft || records.length === 0) return;
          draft.items = [
            ...draft.items,
            ...records.map((record) => ({
              id: record.id,
              record,
              previewUrl: urls.acquire(record.id, record.blob),
            })),
          ];
          setItems(draft.items);
          setError(null);
        } catch (caught) {
          if (active.current === draft)
            setError(caught instanceof AttachmentPolicyError ? caught.code : 'ATTACHMENT_FAILED');
        }
      });
      return draft.pending;
    },
    [urls],
  );

  /** Adds newly selected files after duplicate and complete-draft policy checks. */
  const addFiles = useCallback(
    (files: readonly File[], source: 'file' | 'paste' = 'file') =>
      append(async (draft, existing) => {
        const unique = [...new Set(files)].filter(
          (file) => !draft.items.some((item) => item.record.blob === file),
        );
        return unique.length === 0 ? [] : client.addFiles(unique, source, existing);
      }),
    [append, client],
  );

  /** Loads an already persisted screenshot into the same bounded draft strip. */
  const addExisting = useCallback(
    (id: string) =>
      append(async (draft, existing) => {
        if (draft.items.some((item) => item.id === id)) return [];
        const record = await client.get(id);
        if (record === undefined) throw new Error('Attachment is missing.');
        const checked = validateImageBatch([record.blob], existing);
        if (!checked.ok) throw new AttachmentPolicyError(checked.code);
        return [record];
      }),
    [append, client],
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

  /** Releases only the selected or successfully sent previews, including during another upload. */
  const remove = useCallback(
    (...ids: string[]): void => {
      const draft = active.current;
      if (!draft) return;
      setError((current) => (current === error ? null : current));
      if (ids.length === 0) return;
      for (const id of ids) urls.release(id);
      draft.items = draft.items.filter((item) => !ids.includes(item.id));
      setItems(draft.items);
    },
    [urls, error],
  );

  /** Clears every draft item and revokes all preview URLs without deleting durable Blobs. */
  const clear = useCallback((): void => {
    if (!active.current) return;
    active.current = emptyDraft();
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
