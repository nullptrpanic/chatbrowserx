import { afterEach, expect, it, vi } from 'vitest';
import {
  closeTranslationLens,
  toggleTranslationLens,
} from '../../src/page/translation/mount-translation-lens';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import type { ExtensionMessage, ExtensionResponse } from '../../src/shared/protocol/message-types';
import { inspectionFixture } from './inspection-fixture';
import { translationSampleSchema } from '../../src/translation/region-translation';

function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
  document.body.innerHTML = '<main>Static title</main><canvas></canvas>';
  const attach = Element.prototype.attachShadow;
  let shadow!: ShadowRoot;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    shadow = attach.call(this, init);
    return shadow;
  });
  const reads: { message: ExtensionMessage; finish: (r: ExtensionResponse) => void }[] = [];
  let holdInspection = false;
  let releaseInspection: (() => void) | undefined;
  let changing = false,
    inspections = 0,
    inspectionFails = false;
  const send = vi.fn<RuntimePort['send']>(async (m) => {
    if (m.type === 'translation.inspect') {
      inspections++;
      if (inspectionFails)
        return {
          version: 1,
          requestId: m.requestId,
          ok: false,
          error: { code: 'CAPTURE_FAILED', message: 'Capture failed.' },
        };
      const sample = inspectionFixture(m);
      if (!sample.ok) throw new Error('Fixture failed.');
      const { tiles } = translationSampleSchema.parse(sample.data);
      for (const tile of tiles)
        if (tile.rect.x >= 576) tile.fingerprint = changing ? `frame-${inspections}` : 'still';
      if (holdInspection)
        await new Promise<void>((resolve) => {
          releaseInspection = resolve;
        });
      return { ...sample, data: { tiles } };
    }
    if (m.type === 'translation.read')
      return new Promise((finish) => reads.push({ message: m, finish }));
    return { version: 1, requestId: m.requestId, ok: true, data: { active: true } };
  });
  toggleTranslationLens(
    { sessionId: 'dynamic', loadingText: '翻译中', errorText: '失败' },
    document,
    window,
    { send },
  );
  return {
    shadow,
    reads,
    send,
    changing(value: boolean) {
      changing = value;
    },
    failInspection(value: boolean) {
      inspectionFails = value;
    },
    inspections: () => inspections,
    holdInspection() {
      holdInspection = true;
    },
    releaseInspection() {
      holdInspection = false;
      releaseInspection?.();
    },
    finish(
      index: number,
      blocks = [
        { text: 'Static title', translation: '静态标题', box: [100, 300, 200, 50] },
        { text: 'Old frame', translation: '旧画面', box: [650, 300, 200, 50] },
      ],
    ) {
      const read = reads[index];
      if (!read) throw new Error('Missing translation request.');
      read.finish({
        version: 1,
        requestId: read.message.requestId,
        ok: true,
        data: {
          blocks,
          colors: [],
        },
      });
    },
  };
}

afterEach(() => {
  closeTranslationLens();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('invalidates a whole painted text line when only part of its pixels change', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0, [
    { text: 'Spans two areas', translation: '跨区域的文字', box: [350, 300, 300, 50] },
  ]);
  await vi.advanceTimersByTimeAsync(20);
  const line = lens.shadow.querySelector('.text');
  expect(line?.isConnected).toBe(true);
  lens.changing(true);
  await vi.advanceTimersByTimeAsync(1100);
  expect(line?.isConnected).toBe(false);
});

it('samples canvas pixels without DOM changes and stops retranslating a continuously changing region', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const title = lens.shadow.querySelector('.text');
  expect(title?.textContent).toBe('静态标题');
  lens.changing(true);
  await vi.advanceTimersByTimeAsync(6000);
  expect(lens.inspections()).toBeGreaterThanOrEqual(5);
  expect(title?.isConnected).toBe(true);
  expect(lens.reads).toHaveLength(1);
  expect(lens.shadow.querySelector<HTMLElement>('[role=status]')?.hidden).toBe(true);
});

it('does not resurrect an invalidated region after it stops changing', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const title = lens.shadow.querySelector('.text');
  lens.changing(true);
  await vi.advanceTimersByTimeAsync(4000);
  lens.changing(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(lens.reads).toHaveLength(2);
  expect(title?.isConnected).toBe(true);
  expect(lens.shadow.querySelector<HTMLElement>('[role=status]')?.hidden).toBe(false);
});

it('keeps inspecting while a model request is pending, preserving only the unchanged part of its result', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.changing(true);
  await vi.advanceTimersByTimeAsync(4000);
  expect(lens.inspections()).toBeGreaterThan(3);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.shadow.querySelector('.text')?.textContent).toBe('静态标题');
  expect(lens.reads).toHaveLength(1);
  expect(lens.shadow.querySelector<HTMLElement>('[role=status]')?.hidden).toBe(true);
});

it('ignores DOM-only churn when the sampled pixels remain unchanged', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const title = lens.shadow.querySelector('.text');
  for (let i = 0; i < 4; i++) {
    document.body.className = `tick-${i}`;
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(title?.isConnected).toBe(true);
  expect(lens.reads).toHaveLength(1);
});

it('stops passive captures when the lens closes', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(3000);
  const before = lens.inspections();
  expect(before).toBeGreaterThan(0);
  closeTranslationLens();
  await vi.advanceTimersByTimeAsync(10000);
  expect(lens.inspections()).toBe(before);
});

it('pauses failed inspections until movement and revalidates cached pixels without a model retry', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.finish(0);
  await vi.advanceTimersByTimeAsync(20);
  const verified = lens.shadow.querySelector('.text')?.parentElement?.parentElement;
  expect(verified).toBeDefined();
  lens.failInspection(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(verified?.style.clipPath).toBe('inset(100%)');
  expect(lens.reads).toHaveLength(1);
  const inspections = lens.inspections();
  lens.failInspection(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(lens.inspections()).toBe(inspections);
  expect(verified?.style.clipPath).toBe('inset(100%)');
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 610, clientY: 400 }));
  await vi.advanceTimersByTimeAsync(100);
  expect(verified?.style.clipPath).not.toBe('inset(100%)');
  expect(lens.reads).toHaveLength(1);
  expect(lens.shadow.querySelector<HTMLElement>('[role=status]')?.hidden).toBe(true);
});

it('stops screenshot sampling after a model failure and ignores same-position pointer events', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  const first = lens.reads[0];
  if (!first) throw new Error('Missing translation request');
  first.finish({
    version: 1,
    requestId: first.message.requestId,
    ok: false,
    error: { code: 'MODEL_RATE_LIMIT', message: 'Upstream private details must not be displayed.' },
  });
  await vi.advanceTimersByTimeAsync(20);
  const inspections = lens.inspections();
  for (let i = 0; i < 3; i++) {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600, clientY: 400 }));
    document.body.className = `unrelated-${i}`;
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(lens.inspections()).toBe(inspections);
  expect(lens.reads).toHaveLength(1);
  expect(lens.shadow.querySelector('[role=status]')?.textContent).toContain('MODEL_RATE_LIMIT');
  expect(lens.shadow.textContent).not.toContain('private details');
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 610, clientY: 400 }));
  await vi.advanceTimersByTimeAsync(900);
  expect(lens.inspections()).toBe(inspections + 1);
  expect(lens.reads).toHaveLength(2);
  lens.finish(1);
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.shadow.querySelector<HTMLElement>('[role=status]')?.hidden).toBe(true);
});

it('does not use a pre-error inspection to authorize pixels after the user retries', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(900);
  lens.holdInspection();
  await vi.advanceTimersByTimeAsync(200);
  expect(lens.inspections()).toBe(2);
  const first = lens.reads[0];
  if (!first) throw new Error('Missing translation request');
  first.finish({
    version: 1,
    requestId: first.message.requestId,
    ok: false,
    error: { code: 'MODEL_RATE_LIMIT', message: 'Rate limited.' },
  });
  await vi.advanceTimersByTimeAsync(20);
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 610, clientY: 400 }));
  lens.releaseInspection();
  await vi.advanceTimersByTimeAsync(900);
  expect(lens.reads).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1100);
  expect(lens.inspections()).toBeGreaterThanOrEqual(3);
  expect(lens.reads).toHaveLength(2);
});
