import { z } from 'zod';
import type { PageObservationContentPort } from '../../browser/observation/page-observer';
import type { IdGenerator } from '../../shared/ids';
import {
  PROTOCOL_VERSION,
  type ExtensionResponse,
  type PageCommand,
} from '../../shared/protocol/message-types';
import type { ContentScriptInstaller } from './content-script-installer';

const headingSchema = z
  .object({ level: z.number().int().min(1).max(6), text: z.string().max(500) })
  .strict();
const linkSchema = z.object({ text: z.string().max(500), url: z.string().max(4_096) }).strict();
const contentSchema = z
  .object({
    title: z.string().max(500),
    url: z.string().max(4_096),
    text: z.string().max(40_000),
    headings: z.array(headingSchema).max(100),
    links: z.array(linkSchema).max(100),
    truncated: z.boolean(),
  })
  .strict();
const pageActionResultSchema = z
  .object({
    action: z.literal('scroll'),
    applied: z.boolean(),
    url: z.string().max(4_096),
    reason: z.literal('scroll_target_not_found').optional(),
    moved: z.boolean(),
    actualDeltaX: z.number().finite(),
    actualDeltaY: z.number().finite(),
  })
  .strict();
const overlayStateSchema = z.object({ hidden: z.boolean() }).strict();

export type PageActionInput = Extract<
  PageCommand,
  { readonly type: 'page.action.perform' }
>['payload'];
export type PageActionOutput = z.infer<typeof pageActionResultSchema>;

export type PageObservationPortErrorCode = 'PAGE_UNAVAILABLE' | 'INVALID_PAGE_RESPONSE';

export class PageObservationPortError extends Error {
  readonly code: PageObservationPortErrorCode;

  constructor(code: PageObservationPortErrorCode, message: string) {
    super(message);
    this.name = 'PageObservationPortError';
    this.code = code;
  }
}

export interface ChromePageObservationDependencies {
  readonly installer: Pick<ContentScriptInstaller, 'ensureInstalled'>;
  readonly tabs: {
    get(tabId: number): Promise<{ readonly url?: string | undefined }>;
    sendMessage(
      tabId: number,
      message: PageCommand,
      options: { readonly frameId: number },
    ): Promise<unknown>;
  };
  readonly ids: Pick<IdGenerator, 'create'>;
}

/** Calls the guarded isolated page bundle and validates every untrusted DOM-derived response. */
export class ChromePageObservationPort implements PageObservationContentPort {
  readonly #dependencies: ChromePageObservationDependencies;

  constructor(dependencies: ChromePageObservationDependencies) {
    this.#dependencies = dependencies;
  }

  async readContent(tabId: number) {
    return this.#parse(
      contentSchema,
      await this.#send(tabId, (requestId) => ({
        version: PROTOCOL_VERSION,
        requestId,
        type: 'page.content.read',
        payload: {},
      })),
    );
  }

  async performAction(tabId: number, action: PageActionInput): Promise<PageActionOutput> {
    return this.#parse(
      pageActionResultSchema,
      await this.#send(tabId, (requestId) => ({
        version: PROTOCOL_VERSION,
        requestId,
        type: 'page.action.perform',
        payload: action,
      })),
    );
  }

  async setOverlaysHidden(tabId: number, hidden: boolean): Promise<void> {
    const state = this.#parse(
      overlayStateSchema,
      await this.#send(tabId, (requestId) => ({
        version: PROTOCOL_VERSION,
        requestId,
        type: 'page.overlays.setHidden',
        payload: { hidden },
      })),
    );
    if (state.hidden !== hidden) {
      throw new PageObservationPortError(
        'INVALID_PAGE_RESPONSE',
        'The page returned an invalid observation.',
      );
    }
  }

  #parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new PageObservationPortError(
        'INVALID_PAGE_RESPONSE',
        'The page returned an invalid observation.',
      );
    }
    return parsed.data;
  }

  async #send(tabId: number, command: (requestId: string) => PageCommand): Promise<unknown> {
    const requestId = this.#dependencies.ids.create('pageCommand').trim();
    if (requestId.length === 0 || requestId.length > 128) {
      throw new PageObservationPortError(
        'PAGE_UNAVAILABLE',
        'The page command could not be created.',
      );
    }
    try {
      const tab = await this.#dependencies.tabs.get(tabId);
      const installation = await this.#dependencies.installer.ensureInstalled(tabId, tab.url ?? '');
      if (
        installation.status === 'permission_required' ||
        installation.status === 'unsupported_origin'
      ) {
        throw new PageObservationPortError('PAGE_UNAVAILABLE', 'This page cannot be observed.');
      }
      const raw = await this.#dependencies.tabs.sendMessage(tabId, command(requestId), {
        frameId: 0,
      });
      if (!this.#isSuccessfulResponse(raw, requestId)) {
        throw new PageObservationPortError(
          'INVALID_PAGE_RESPONSE',
          'The page returned an invalid observation.',
        );
      }
      return raw.data;
    } catch (error) {
      if (error instanceof PageObservationPortError) throw error;
      if (error instanceof z.ZodError) {
        throw new PageObservationPortError(
          'INVALID_PAGE_RESPONSE',
          'The page returned an invalid observation.',
        );
      }
      throw new PageObservationPortError('PAGE_UNAVAILABLE', 'The page could not be observed.');
    }
  }

  #isSuccessfulResponse(
    value: unknown,
    requestId: string,
  ): value is Extract<ExtensionResponse, { readonly ok: true }> {
    return (
      typeof value === 'object' &&
      value !== null &&
      'version' in value &&
      value.version === PROTOCOL_VERSION &&
      'requestId' in value &&
      value.requestId === requestId &&
      'ok' in value &&
      value.ok === true &&
      'data' in value
    );
  }
}
