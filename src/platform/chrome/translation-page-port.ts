import { z } from 'zod';
import type { TranslationLensOptions } from '../../translation/region-translation';
import type { PageCommand } from '../../shared/protocol/message-types';
import type { ScreenshotPagePortDependencies } from './screenshot-page-port';
import { TranslationStateError } from '../../translation/translation-state-error';

interface TranslationPagePortDependencies {
  readonly installer: ScreenshotPagePortDependencies['installer'];
  readonly ids: ScreenshotPagePortDependencies['ids'];
  readonly tabs: {
    get(tabId: number): Promise<{ readonly url?: string | undefined; readonly active: boolean }>;
    sendMessage: ScreenshotPagePortDependencies['tabs']['sendMessage'];
  };
}

const responseSchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  ok: z.literal(true),
  data: z.unknown(),
});
const sessionSchema = z.object({ sessionId: z.string().min(1).max(128).nullable() });
const activeSchema = z.object({ active: z.boolean() });
const unsupportedSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.literal('INVALID_PAGE_COMMAND') }),
});

/** Top-frame translation commands, with bounded replies and no installation during status probes. */
export class ChromeTranslationPagePort {
  constructor(readonly dependencies: TranslationPagePortDependencies) {}

  async getSession(tabId: number): Promise<string | null> {
    // This query is read-only. Retry once, never replay a toggle or infer closure from a
    // missing reply. Each attempt rechecks the active tab and the page-owned session.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!(await this.dependencies.tabs.get(tabId)).active) return null;
        const reply = await this.#send(tabId, { type: 'page.translation.getState', payload: {} });
        return sessionSchema.parse(reply).sessionId;
      } catch (error) {
        // A fresh document has no on-demand receiver yet. This is distinct from a
        // receiver that accepted a message but lost its reply or timed out.
        if (
          error instanceof Error &&
          error.message === 'Could not establish connection. Receiving end does not exist.'
        )
          return null;
        // An unavailable reply is not evidence that the user closed the lens.
      }
    }
    throw new TranslationStateError('TRANSLATION_PAGE_UNAVAILABLE');
  }

  async toggle(tabId: number, options: TranslationLensOptions): Promise<boolean> {
    const { tabs, installer } = this.dependencies;
    const tab = await tabs.get(tabId);
    const installation = await installer.ensureInstalled(tabId, tab.url ?? '');
    if (!['installed', 'already_installed'].includes(installation.status))
      throw new Error('Page unavailable.');
    try {
      return activeSchema.parse(
        await this.#send(
          tabId,
          {
            type: 'page.translation.toggle',
            payload: options,
          },
          tab.url ?? '',
        ),
      ).active;
    } catch (error) {
      // A lost acknowledgement does not prove the action failed. Reconcile the exact new
      // session, but never replay an ambiguous toggle (which could close the working lens).
      if ((await this.getSession(tabId).catch(() => null)) === options.sessionId) return true;
      throw error;
    }
  }

  async #send(
    tabId: number,
    command:
      | { type: 'page.translation.getState'; payload: Record<string, never> }
      | { type: 'page.translation.toggle'; payload: TranslationLensOptions },
    reinstallUrl?: string,
  ): Promise<unknown> {
    const requestId = this.dependencies.ids.create('translation');
    const message: PageCommand = { version: 1, requestId, ...command };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.dependencies.tabs.sendMessage(tabId, message, { frameId: 0 }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Translation page timed out.')), 3000);
        }),
      ]);
      // An unsupported command did not toggle anything. Never retry a timeout or ambiguous reply.
      if (reinstallUrl !== undefined && unsupportedSchema.safeParse(reply).success) {
        await this.dependencies.installer.ensureInstalled(tabId, reinstallUrl, true);
        return this.#send(tabId, command);
      }
      const result = responseSchema.parse(reply);
      if (result.requestId !== requestId) throw new Error('Translation response mismatch.');
      return result.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
