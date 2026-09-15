import { expect, it, vi } from 'vitest';
import { readImageResource } from '../../src/browser/observation/image-resource';

function fixture(type = 'Image', size = 3) {
  const released: string[] = [],
    owners: string[] = [];
  const send = vi.fn<
    (target: unknown, method: string, params?: unknown, signal?: AbortSignal) => Promise<unknown>
  >(async (_target, method) =>
    method === 'Page.getResourceTree'
      ? {
          frameTree: {
            frame: { id: 'root' },
            resources: [
              {
                url: 'https://cdn.test/image.png',
                type,
                mimeType: 'image/png',
                contentSize: size,
              },
            ],
          },
        }
      : { content: 'YWJj', base64Encoded: true },
  );
  const ports = {
    transport: { send },
    sessions: {
      async retain(_tab: number, owner: string) {
        owners.push(owner);
      },
      async releaseOwner(owner: string) {
        released.push(owner);
      },
      async ensure() {
        return { root: { tabId: 7 } };
      },
    },
  };
  return { ports, send, released, owners };
}

it('reads only a loaded root-frame image and releases only its own debugger owner', async () => {
  const { ports, owners, released, send } = fixture();
  expect(
    await readImageResource(ports, 7, 'https://cdn.test/image.png', new AbortController().signal),
  ).toEqual({ mimeType: 'image/png', data: 'YWJj' });
  expect(send).toHaveBeenLastCalledWith(
    { tabId: 7 },
    'Page.getResourceContent',
    { frameId: 'root', url: 'https://cdn.test/image.png' },
    expect.any(AbortSignal),
  );
  expect(owners).toHaveLength(1);
  expect(released).toEqual(owners);
});

it('passes cancellation into an in-flight resource command and still releases its owner', async () => {
  const { ports, send, released, owners } = fixture();
  const abort = new AbortController();
  send.mockImplementation(async (_target, _method, _params, signal) => {
    if (!signal) throw new Error('Cancellation was not forwarded');
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  });
  const pending = readImageResource(ports, 7, 'https://cdn.test/image.png', abort.signal);
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(released).toEqual(owners);
});

it.each([
  ['not loaded', 'Image', 3, 'https://unrequested.test/private'],
  ['not an image', 'Document', 3, 'https://cdn.test/image.png'],
  ['oversized', 'Image', 5 * 1024 * 1024, 'https://cdn.test/image.png'],
])('does not read %s resources', async (_case, type, size, url) => {
  const { ports, send, owners, released } = fixture(type as string, size as number);
  expect(await readImageResource(ports, 7, url as string, new AbortController().signal)).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  expect(released).toEqual(owners);
});

it('rejects oversized bodies even when resource metadata was small', async () => {
  const { ports, send } = fixture();
  send.mockImplementation(async (_target, method) =>
    method === 'Page.getResourceTree'
      ? {
          frameTree: {
            frame: { id: 'root' },
            resources: [
              {
                url: 'https://cdn.test/image.png',
                type: 'Image',
                mimeType: 'image/png',
                contentSize: 1,
              },
            ],
          },
        }
      : { content: 'a'.repeat(6 * 1024 * 1024), base64Encoded: true },
  );
  expect(
    await readImageResource(ports, 7, 'https://cdn.test/image.png', new AbortController().signal),
  ).toBeNull();
});
