import { describe, expect, it } from 'vitest';
import { productRevisionForState, resolveLiveProductTarget } from '../../runner/product-revision';

describe('live product revision', () => {
  it('keeps the commit SHA unchanged for a clean workspace', () => {
    expect(productRevisionForState('abc123', '', [])).toBe('abc123');
  });

  it('adds a deterministic opaque fingerprint for tracked and untracked changes', () => {
    const untracked = [{ path: 'src/new.ts', mode: 0o100644, objectId: 'blob-a' }];
    const first = productRevisionForState('abc123', 'tracked patch', untracked);
    const second = productRevisionForState('abc123', 'tracked patch', [...untracked]);

    expect(first).toBe(second);
    expect(first).toMatch(/^abc123-dirty-[a-f0-9]{16}$/);
    expect(first).not.toContain('src/new.ts');
    expect(first).not.toContain('tracked patch');
  });

  it('changes when tracked content, untracked content, path, or mode changes', () => {
    const baseline = productRevisionForState('abc123', 'tracked patch', [
      { path: 'src/new.ts', mode: 0o100644, objectId: 'blob-a' },
    ]);

    expect(productRevisionForState('abc123', 'other patch', [])).not.toBe(baseline);
    expect(
      productRevisionForState('abc123', 'tracked patch', [
        { path: 'src/new.ts', mode: 0o100644, objectId: 'blob-b' },
      ]),
    ).not.toBe(baseline);
    expect(
      productRevisionForState('abc123', 'tracked patch', [
        { path: 'src/other.ts', mode: 0o100644, objectId: 'blob-a' },
      ]),
    ).not.toBe(baseline);
    expect(
      productRevisionForState('abc123', 'tracked patch', [
        { path: 'src/new.ts', mode: 0o100755, objectId: 'blob-a' },
      ]),
    ).not.toBe(baseline);
  });

  it('uses the workspace build and revision by default', () => {
    expect(
      resolveLiveProductTarget({
        environment: {},
        repositoryRoot: '/workspace/chatbrowserx',
        workspaceRevision: 'abc123-dirty-deadbeefdeadbeef',
      }),
    ).toEqual({
      extensionPath: '/workspace/chatbrowserx/dist',
      productRevision: 'abc123-dirty-deadbeefdeadbeef',
    });
  });

  it('allows an external extension build only with an explicit revision label', () => {
    expect(
      resolveLiveProductTarget({
        environment: {
          CHATBROWSERX_LIVE_EXTENSION_PATH: '../baseline/dist',
          CHATBROWSERX_LIVE_PRODUCT_REVISION: 'cf94a24+baseline',
        },
        repositoryRoot: '/workspace/chatbrowserx',
        workspaceRevision: 'candidate',
      }),
    ).toEqual({
      extensionPath: '/workspace/baseline/dist',
      productRevision: 'cf94a24+baseline',
    });
  });

  it('rejects an external build without a paired revision label', () => {
    expect(() =>
      resolveLiveProductTarget({
        environment: { CHATBROWSERX_LIVE_EXTENSION_PATH: '/tmp/baseline/dist' },
        repositoryRoot: '/workspace/chatbrowserx',
        workspaceRevision: 'candidate',
      }),
    ).toThrow('must be set together');
  });

  it('rejects an unsafe revision label', () => {
    expect(() =>
      resolveLiveProductTarget({
        environment: {
          CHATBROWSERX_LIVE_EXTENSION_PATH: '/tmp/baseline/dist',
          CHATBROWSERX_LIVE_PRODUCT_REVISION: 'baseline secret label',
        },
        repositoryRoot: '/workspace/chatbrowserx',
        workspaceRevision: 'candidate',
      }),
    ).toThrow('revision label');
  });
});
