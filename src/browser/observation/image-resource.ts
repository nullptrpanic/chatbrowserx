import type { Protocol } from 'devtools-protocol';
import type { DebuggerSession } from '../debugger/debugger-transport';

interface ImageResourcePorts {
  sessions: {
    retain(tabId: number, owner: string): Promise<void>;
    releaseOwner(owner: string): Promise<void>;
    ensure(tabId: number, signal: AbortSignal): Promise<{ root: DebuggerSession }>;
  };
  transport: {
    send(
      target: DebuggerSession,
      method: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown>;
  };
}

/** Reads existing root-frame image bytes only. Never fetches arbitrary URLs or captures overlays. */
export async function readImageResource(
  ports: ImageResourcePorts,
  tabId: number,
  url: string,
  signal: AbortSignal,
): Promise<{ mimeType: string; data: string } | null> {
  signal.throwIfAborted();
  const owner = `translation-image:${crypto.randomUUID()}`;
  await ports.sessions.retain(tabId, owner);
  try {
    const { root } = await ports.sessions.ensure(tabId, signal);
    const { frameTree } = (await ports.transport.send(
      root,
      'Page.getResourceTree',
      undefined,
      signal,
    )) as Protocol.Page.GetResourceTreeResponse;
    signal.throwIfAborted();
    const source = frameTree.resources.find((r) => r.url === url && r.type === 'Image');
    if (
      !source ||
      source.failed ||
      source.canceled ||
      !/^image\/[\w.+-]+$/.test(source.mimeType) ||
      (source.contentSize ?? 0) > 4 * 1024 * 1024
    )
      return null;
    const result = (await ports.transport.send(
      root,
      'Page.getResourceContent',
      {
        frameId: frameTree.frame.id,
        url,
      },
      signal,
    )) as Protocol.Page.GetResourceContentResponse;
    signal.throwIfAborted();
    if (
      !result.base64Encoded ||
      result.content.length > Math.ceil((4 * 1024 * 1024) / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(result.content)
    )
      return null;
    return { mimeType: source.mimeType, data: result.content };
  } catch {
    signal.throwIfAborted();
    return null;
  } finally {
    await ports.sessions.releaseOwner(owner);
  }
}
