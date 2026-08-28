import { describe, expect, it } from 'vitest';
import { compactBrowserModelOutput } from '../../src/browser/browser-model-output';

describe('compactBrowserModelOutput', () => {
  it('removes only the protocol-defined null observation from a known success envelope', () => {
    const full = JSON.stringify({
      ok: true,
      tabId: 7,
      url: 'https://example.com/',
      data: { title: 'Example', active: true },
      observation: null,
    });

    expect(compactBrowserModelOutput(full)).toBe(
      JSON.stringify({
        ok: true,
        tabId: 7,
        url: 'https://example.com/',
        data: { title: 'Example', active: true },
      }),
    );
  });

  it.each([
    ['failure', JSON.stringify({ ok: false, code: 'STALE_REF', retryable: true })],
    ['malformed JSON', '{not-json'],
    [
      'unknown top-level field',
      JSON.stringify({
        ok: true,
        tabId: 7,
        url: 'https://example.com/',
        data: {},
        observation: null,
        futureEvidence: { important: true },
      }),
    ],
    [
      'non-null observation',
      JSON.stringify({
        ok: true,
        tabId: 7,
        url: 'https://example.com/',
        data: {},
        observation: { kind: 'page_state' },
      }),
    ],
    [
      'missing required envelope field',
      JSON.stringify({ ok: true, tabId: 7, data: {}, observation: null }),
    ],
  ])('returns %s byte-for-byte when equivalence is not proven', (_name, full) => {
    expect(compactBrowserModelOutput(full)).toBe(full);
  });

  it('drops only passive node tombstones from traversal model evidence', () => {
    const full = JSON.stringify({
      ok: true,
      tabId: 7,
      url: 'https://example.com/document',
      data: {
        action: 'scroll',
        mode: 'traverse',
        stopReason: 'boundary_verified',
        continuationRequired: false,
        latestSnapshot: 'snapshot_2',
        observations: [
          {
            mode: 'interactive',
            snapshot: 'snapshot_2',
            base: 'snapshot_1',
            remove: ['node:passive-old', 'ref:stale-action'],
            upsert: [
              {
                k: 'node:paragraph',
                e: { d: 4, r: 'statictext', n: 'New paragraph' },
              },
            ],
            coverage: { targets: ['ref_document'], primaryTarget: 'ref_document' },
          },
        ],
      },
      observation: null,
    });

    const compact = JSON.parse(compactBrowserModelOutput(full)) as {
      readonly data: {
        readonly latestSnapshot: string;
        readonly observations: readonly {
          readonly remove: readonly string[];
          readonly coverage: Readonly<Record<string, unknown>>;
        }[];
      };
      readonly observation?: unknown;
    };

    expect(compact.observation).toBeUndefined();
    expect(compact.data.latestSnapshot).toBe('snapshot_2');
    expect(compact.data.observations[0]?.remove).toEqual(['ref:stale-action']);
    expect(compact.data.observations[0]?.coverage).toEqual({
      targets: ['ref_document'],
      primaryTarget: 'ref_document',
    });
  });

  it('drops passive tombstones from a single scroll verification without losing coverage', () => {
    const full = JSON.stringify({
      ok: true,
      tabId: 7,
      url: 'https://example.com/document',
      data: {
        action: 'scroll',
        requestedDeltaApplied: true,
        verification: {
          mode: 'interactive',
          snapshot: 'snapshot_2',
          base: 'snapshot_1',
          remove: ['node:old-paragraph', 'ref:stale-action'],
          upsert: [{ k: 'node:new-paragraph', e: { d: 4, r: 'statictext', n: 'New text' } }],
          coverage: { targets: ['ref_document'], primaryTarget: 'ref_document' },
        },
      },
      observation: null,
    });

    expect(JSON.parse(compactBrowserModelOutput(full))).toEqual({
      ok: true,
      tabId: 7,
      url: 'https://example.com/document',
      data: {
        action: 'scroll',
        requestedDeltaApplied: true,
        verification: {
          mode: 'interactive',
          snapshot: 'snapshot_2',
          base: 'snapshot_1',
          remove: ['ref:stale-action'],
          upsert: [{ k: 'node:new-paragraph', e: { d: 4, r: 'statictext', n: 'New text' } }],
          coverage: { targets: ['ref_document'], primaryTarget: 'ref_document' },
        },
      },
    });
  });

  it('compacts traversal evidence while preserving a non-null action observation', () => {
    const full = JSON.stringify({
      ok: true,
      tabId: 7,
      url: 'https://example.com/document',
      data: {
        action: 'scroll',
        mode: 'traverse',
        observations: [
          {
            mode: 'interactive',
            snapshot: 'snapshot_2',
            base: 'snapshot_1',
            remove: ['node:passive-old'],
            upsert: [{ k: 'node:paragraph', e: { d: 4, r: 'statictext', n: 'New paragraph' } }],
          },
        ],
      },
      observation: { targetPresent: true, targetObscured: false },
    });

    const compact = JSON.parse(compactBrowserModelOutput(full)) as {
      readonly data: { readonly observations: readonly Readonly<Record<string, unknown>>[] };
      readonly observation: Readonly<Record<string, unknown>>;
    };

    expect(compact.observation).toEqual({ targetPresent: true, targetObscured: false });
    expect(compact.data.observations[0]).not.toHaveProperty('remove');
    expect(compactBrowserModelOutput(full).length).toBeLessThan(full.length);
  });

  it('deduplicates unchanged identities while retaining changed and first actionable entries', () => {
    const passive = { d: 4, r: 'statictext', n: 'Repeated paragraph' };
    const actionable = {
      d: 2,
      r: 'region',
      n: 'Document',
      a: ['scroll'],
      ref: 'ref_document',
    };
    const full = JSON.stringify({
      ok: true,
      tabId: 7,
      url: 'https://example.com/document',
      data: {
        action: 'scroll',
        mode: 'traverse',
        observations: [
          {
            mode: 'interactive',
            snapshot: 'snapshot_1',
            upsert: [
              { k: 'node:paragraph', e: passive },
              { k: 'ref:ref_document', e: actionable },
            ],
          },
          {
            mode: 'interactive',
            snapshot: 'snapshot_2',
            base: 'snapshot_1',
            upsert: [
              { k: 'node:paragraph', e: passive },
              {
                k: 'node:paragraph',
                e: { d: 4, r: 'statictext', n: 'Changed paragraph' },
              },
              { k: 'ref:ref_document', e: actionable },
            ],
          },
        ],
      },
      observation: null,
    });

    const compact = JSON.parse(compactBrowserModelOutput(full)) as {
      readonly data: {
        readonly observations: readonly {
          readonly upsert: readonly { readonly k: string; readonly e: { readonly n: string } }[];
        }[];
      };
    };

    expect(compact.data.observations[0]?.upsert.map(({ e }) => e.n)).toEqual([
      'Repeated paragraph',
      'Document',
    ]);
    expect(compact.data.observations[1]?.upsert.map(({ e }) => e.n)).toEqual(['Changed paragraph']);
  });

  it('preserves ordered state changes while dropping repeated transport state', () => {
    const full = JSON.stringify({
      ok: true,
      tabId: 7,
      url: 'https://example.com/document',
      data: {
        action: 'scroll',
        mode: 'traverse',
        observations: [
          {
            mode: 'interactive',
            snapshot: 'snapshot_1',
            upsert: [
              {
                k: 'ref:ref_document',
                e: { d: 2, r: 'region', n: 'Document', a: ['scroll'], ref: 'ref_document' },
              },
              { k: 'node:status', e: { d: 4, r: 'statictext', n: 'Loading' } },
            ],
            coverage: { targets: ['ref_document'], primaryTarget: 'ref_document' },
          },
          {
            mode: 'interactive',
            snapshot: 'snapshot_2',
            base: 'snapshot_1',
            upsert: [
              {
                k: 'ref:ref_document',
                e: { d: 2, r: 'region', n: 'Document', a: ['scroll'], ref: 'ref_document' },
              },
              { k: 'node:status', e: { d: 4, r: 'statictext', n: 'Ready' } },
              { k: 'node:item:1', e: { d: 4, r: 'statictext', n: 'Repeated title' } },
            ],
            coverage: { targets: ['ref_document'], primaryTarget: 'ref_document' },
          },
          {
            mode: 'interactive',
            snapshot: 'snapshot_3',
            base: 'snapshot_2',
            remove: ['node:status'],
            upsert: [
              { k: 'node:status', e: { d: 4, r: 'statictext', n: 'Loading' } },
              { k: 'node:item:2', e: { d: 4, r: 'statictext', n: 'Repeated title' } },
            ],
            coverage: { targets: ['ref_document'], primaryTarget: 'ref_document' },
          },
        ],
      },
      observation: null,
    });

    const compact = JSON.parse(compactBrowserModelOutput(full)) as {
      readonly data: {
        readonly observations: readonly {
          readonly upsert: readonly { readonly k: string; readonly e: { readonly n: string } }[];
          readonly coverage?: Readonly<Record<string, unknown>>;
        }[];
      };
    };

    expect(compact.data.observations.map(({ upsert }) => upsert.map(({ e }) => e.n))).toEqual([
      ['Document', 'Loading'],
      ['Ready', 'Repeated title'],
      ['Loading', 'Repeated title'],
    ]);
    expect(compact.data.observations[0]).not.toHaveProperty('coverage');
    expect(compact.data.observations[1]).not.toHaveProperty('coverage');
    expect(compact.data.observations[2]?.coverage).toEqual({
      targets: ['ref_document'],
      primaryTarget: 'ref_document',
    });
  });
});
