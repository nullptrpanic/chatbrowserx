import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withExistingLiveSession } from '../runner/live-session';
import { resolveLiveProductTarget, resolveProductRevision } from '../runner/product-revision';
import { createPlaywrightLiveRuntime } from '../runner/run-live-scenario';
import { verifyConfiguredLiveEnvironment } from '../runner/live-environment';
import { loadEvaluationSample } from '../runner/sample-loader';
import type { PanelSettingsSnapshot } from '../../src/shared/protocol/panel-types';
import { runDiagnostic } from './diagnostic-cleanup';
import { observeTranslationRequest } from './translation-request';
import { clickTranslationAction } from '../tests/browser/helpers/translation-action';

// A native-feature diagnostic, NOT a WorkSession benchmark. Uses the canonical authenticated
// Profile and readiness contract. No provider mocks, copied credentials or source-page writes.
// Usage: tsx e2e/diagnostics/translation-lens.ts <sample-id> <en|zh-CN> [exact anchor text] [viewport width] [exact navigation text]
const [sampleId, language, anchor, widthArgument, navigationText] = process.argv.slice(2);
if (!sampleId || !['en', 'zh-CN'].includes(language ?? ''))
  throw new Error('Expected a catalog sample ID, en|zh-CN, and optional visible anchor text.');
const viewportWidth = Number(widthArgument ?? 1440);
if (!Number.isInteger(viewportWidth) || viewportWidth < 640 || viewportWidth > 3000)
  throw new Error('Viewport width must be an integer from 640 through 3000.');
const repositoryRoot = process.cwd();
const { scenario } = await loadEvaluationSample(repositoryRoot, sampleId);
const productTarget = resolveLiveProductTarget({
  repositoryRoot,
  environment: process.env,
  workspaceRevision: await resolveProductRevision(repositoryRoot),
});
const output = join(repositoryRoot, 'e2e/.runtime', `lens-${sampleId}-${Date.now()}`);
await mkdir(output, { recursive: true });
console.log('Evidence:', output);
await withExistingLiveSession(
  {
    repositoryRoot,
    environment: process.env,
    productTarget,
    execution: { sampleId, exclusiveResources: scenario.exclusiveResources },
  },
  async (session) => {
    const runtime = createPlaywrightLiveRuntime(session);
    const target = await runtime.openTarget(scenario);
    const readiness = await verifyConfiguredLiveEnvironment(
      runtime,
      scenario,
      target,
      crypto.randomUUID(),
    );
    if (!readiness.passed) throw new Error(JSON.stringify(readiness));
    const page = session.context.pages().find((p) => p.url() === target.url);
    if (!page) throw new Error('Target missing');
    const navigations: { at: number; origin: string; path: string }[] = [];
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = new URL(frame.url());
      navigations.push({
        at: Date.now(),
        origin: url.origin,
        path: url.pathname,
      });
    });
    const snapshot = (await runtime.send({
      version: 1,
      requestId: crypto.randomUUID(),
      type: 'panel.getSnapshot',
      payload: { tabId: target.tabId },
    })) as { settings: PanelSettingsSnapshot };
    const {
      model,
      reasoningEffort,
      systemPrompt,
      historyMessageLimit,
      language: oldLanguage,
    } = snapshot.settings;
    const saved = {
      model,
      reasoningEffort,
      systemPrompt,
      historyMessageLimit,
      language: oldLanguage,
    };
    const requests: {
      at: number;
      image: boolean;
      contextChars: number;
      count: number;
      sourceKeys: number[];
      inspectedIds?: string[];
      markers: { id: string; tokens: string[] }[];
      status?: number;
      finished?: boolean;
      transportFailed?: boolean;
      canceled?: boolean;
    }[] = [];
    const requestFailures = new WeakMap<
      object,
      { record: (typeof requests)[number]; reject: (error: Error) => void }
    >();
    session.context.on('requestfailed', (request) => {
      const pending = requestFailures.get(request);
      if (!pending) return;
      pending.record.canceled = request.failure()?.errorText === 'net::ERR_ABORTED';
      pending.reject(new Error('Observed translation request failure'));
    });
    // Session-local identities expose duplicate requests without retaining page text.
    const sourceKeys = new Map<string, number>();
    const inspectedText = process.env.CHATBROWSERX_LENS_INSPECT_TEXT;
    session.context.on('request', (request) => {
      if (request.url() !== 'https://chatgpt.com/backend-api/codex/responses') return;
      const body = request.postDataJSON() as {
        input?: { content?: { type: string; text?: string }[] }[];
      };
      const content = body.input?.flatMap((m) => m.content ?? []) ?? [];
      const text = content.find((c) => c.type === 'input_text')?.text;
      const payload = text
        ? (JSON.parse(text) as {
            texts?: { id: string; text: string }[];
            context?: string;
          })
        : undefined;
      const record: (typeof requests)[number] = {
        at: Date.now(),
        image: content.some((c) => c.type === 'input_image'),
        contextChars: payload?.context?.length ?? 0,
        count: payload?.texts?.length ?? 0,
        sourceKeys: (payload?.texts ?? []).map(({ text }) => {
          let key = sourceKeys.get(text);
          if (key === undefined) {
            key = sourceKeys.size + 1;
            sourceKeys.set(text, key);
          }
          return key;
        }),
        ...(inspectedText
          ? {
              inspectedIds: (payload?.texts ?? [])
                .filter(({ text }) => text.includes(inspectedText))
                .map(({ id }) => id),
            }
          : {}),
        markers: (payload?.texts ?? []).map((block) => ({
          id: block.id,
          tokens: block.text.match(/<\/?m\d+>/g) ?? [],
        })),
      };
      requests.push(record);
      const failed = new Promise<never>((_, reject) => {
        requestFailures.set(request, { record, reject });
      });
      void observeTranslationRequest(request.response(), record, failed);
    });
    // Keep the browser function as plain JS: tsx's function-name helper is not present in
    // Chrome's isolated execution world. No page data is interpolated into this program.
    const read = () =>
      session.sidePanelPage.evaluate(`(async () => {
    const tabId=${target.tabId};
    const [result] = await chrome.scripting.executeScript({target:{tabId},func:()=>{
      const host=document.querySelector('[data-chatbrowserx-overlay=translation]');
      const root=host&&chrome.dom.openOrClosedShadowRoot(host);
      const rejections=JSON.parse(root?.querySelector('[data-translation-rejections]')?.dataset.translationRejections??'[]');
      const ancestry=node=>{
        const rows=[];
        for(let el=node instanceof Element?node:node?.parentElement;el&&rows.length<12;el=el.parentElement){
          const s=getComputedStyle(el);
          rows.push({tag:el.tagName,classes:String(el.className).slice(0,240),box:el.getBoundingClientRect().toJSON(),
            children:el.childElementCount,chars:el.textContent?.length,editable:el.getAttribute('contenteditable'),
            style:Object.fromEntries(['display','position','overflow','transform','filter','clip-path','height','width','z-index','opacity'].map(k=>[k,s.getPropertyValue(k)]))});
        }
        return rows;
      };
      return {status:host?.dataset.status,hidden:host ? getComputedStyle(host).visibility==='hidden' : true,
        documentHidden:document.hidden,focused:document.hasFocus(),
        inputFocused:document.activeElement?.matches('input,textarea,select,[role=textbox]')||document.activeElement?.isContentEditable||false,
        notice:root?.querySelector('[role=status]')?.textContent,
        rejections,
        coverage:JSON.parse(root?.querySelector('[data-translation-coverage]')?.dataset.translationCoverage??'null'),
        rejectionCounts:rejections.reduce((counts,[,reason])=>{counts[reason]=(counts[reason]??0)+1;return counts;},{}),
        texts:[...(root?.querySelectorAll('.text')??[])].map(el=>({
          id:el.dataset.translationId,chars:el.textContent?.length,font:getComputedStyle(el).fontSize,
          lineHeight:getComputedStyle(el).lineHeight,box:el.getBoundingClientRect().toJSON(),
          owner:el.parentElement?.getBoundingClientRect().toJSON(),
        })),
        tables:[...(root?.querySelectorAll('table')??[])].map(el=>({box:el.getBoundingClientRect().toJSON(),columns:[...el.querySelectorAll('col')].map(c=>c.getBoundingClientRect().width)})),
        groups:[...(root?.querySelectorAll('.translation-group')??[])].map(el=>({
          box:el.getBoundingClientRect().toJSON(),clip:getComputedStyle(el).clipPath,
          mirrors:[...el.children].filter(c=>!c.className?.includes('background')).map(c=>({tag:c.tagName,display:getComputedStyle(c).display,box:c.getBoundingClientRect().toJSON(),children:c.childElementCount}))
        })),
        sourceTables:[...document.querySelectorAll('table')].map(el=>el.getBoundingClientRect().toJSON()),
        images:[...document.images].filter(el=>{const r=el.getBoundingClientRect();return r.width>4&&r.height>4&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;}).slice(0,64).map((el,index)=>({
          index,source:el.getBoundingClientRect().toJSON(),complete:el.complete,naturalWidth:el.naturalWidth,
          ancestors:ancestry(el).slice(0,5),
          copies:[...root?.querySelectorAll('img')??[]].filter(copy=>copy.src===(el.currentSrc||el.src)).map(copy=>({box:copy.getBoundingClientRect().toJSON(),complete:copy.complete,naturalWidth:copy.naturalWidth,ancestors:ancestry(copy).slice(0,5)})),
        })),
        sourceSelection:ancestry(getSelection()?.anchorNode),
        sourceTableAncestors:[...document.querySelectorAll('table')].filter(el=>{const r=el.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight;}).slice(0,2).map(ancestry),
        watermarkCount:root?.querySelectorAll('.translation-watermark').length??0,
        scroll:{x:scrollX,y:scrollY,ports:[...document.querySelectorAll('*')].filter(el=>el.scrollTop||el.scrollLeft).slice(0,12).map(el=>({tag:el.tagName,x:el.scrollLeft,y:el.scrollTop}))},
      };
    }});
    return result?.result;
  })()`) as Promise<
        | {
            status?: string;
            notice?: string;
            hidden: boolean;
            texts: {
              id: string;
              font: string;
              chars: number;
              box: Record<string, number>;
            }[];
            tables: unknown[];
            watermarkCount: number;
          }
        | undefined
      >;
    const stages: {
      label: string;
      requests: number;
      settled: boolean;
      state: Awaited<ReturnType<typeof read>>;
    }[] = [];
    // Bounded, text-free attribution for a failed quiet-state gate. Native carousels,
    // new source IDs, model work and real layout churn must not be conflated.
    const settling: {
      label: string;
      changes: {
        elapsedMs: number;
        fields: string[];
        requests: number;
        pending: number;
        idsChanged: boolean;
        contentsChanged: number;
        sizesChanged: number;
        positionsChanged: number;
        changedBoxes: unknown;
        sourceMotion: unknown;
      }[];
    }[] = [];
    // Capture the frame Chrome is actually presenting. Playwright's screenshot font wait
    // can hang on unrelated late-loading fonts even after the visible baseline is stable.
    const screenshotSession = await page.context().newCDPSession(page);
    const screenshot = async (label: string) => {
      const result = await screenshotSession.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      await writeFile(join(output, `${label}.png`), Buffer.from(result.data, 'base64'));
    };
    const settle = async (label: string): Promise<Awaited<ReturnType<typeof read>>> => {
      const started = Date.now();
      const observation: (typeof settling)[number] = { label, changes: [] };
      settling.push(observation);
      await page.waitForTimeout(1000);
      let state = await read();
      let previous = '',
        stableSince = Date.now(),
        settled = false;
      // A previous terminal state can briefly survive a new lens move while discovery or
      // a streamed response is still pending. Require a quiet, stable terminal snapshot.
      while (Date.now() - started < 150000) {
        if (state?.status === 'error') break;
        if (!state?.status && Date.now() - started > 5000) break;
        const fingerprint = JSON.stringify({
          requests: requests.length,
          state,
        });
        if (fingerprint !== previous) {
          stableSince = Date.now();
          if (previous) {
            const before = (JSON.parse(previous) as { state: typeof state }).state;
            const oldTexts = new Map(before?.texts.map((t) => [t.id, t]) ?? []);
            const current = state?.texts ?? [];
            observation.changes.push({
              elapsedMs: Date.now() - started,
              fields: Object.keys(state ?? {}).filter(
                (key) =>
                  JSON.stringify(before?.[key as keyof typeof before]) !==
                  JSON.stringify(state?.[key as keyof typeof state]),
              ),
              requests: requests.length,
              pending: requests.filter((r) => !r.finished).length,
              idsChanged:
                oldTexts.size !== current.length || current.some((t) => !oldTexts.has(t.id)),
              contentsChanged: current.filter((t) => {
                const old = oldTexts.get(t.id);
                return old && (old.chars !== t.chars || old.font !== t.font);
              }).length,
              sizesChanged: current.filter((t) => {
                const old = oldTexts.get(t.id);
                return old && (old.box.width !== t.box.width || old.box.height !== t.box.height);
              }).length,
              positionsChanged: current.filter((t) => {
                const old = oldTexts.get(t.id);
                return old && (old.box.x !== t.box.x || old.box.y !== t.box.y);
              }).length,
              changedBoxes: {
                added: current.filter((t) => !oldTexts.has(t.id)).slice(0, 16),
                removed: [...oldTexts.values()]
                  .filter((t) => !current.some((c) => c.id === t.id))
                  .slice(0, 16),
                moved: current
                  .filter((t) => {
                    const old = oldTexts.get(t.id);
                    return old && (old.box.x !== t.box.x || old.box.y !== t.box.y);
                  })
                  .slice(0, 16)
                  .map((t) => ({
                    id: t.id,
                    before: oldTexts.get(t.id)?.box,
                    after: t.box,
                  })),
              },
              sourceMotion: await page.evaluate(() =>
                document
                  .getAnimations()
                  .filter((animation) => {
                    const effect = animation.effect;
                    const target = effect instanceof KeyframeEffect ? effect.target : null;
                    if (!(target instanceof Element)) return false;
                    const r = target.getBoundingClientRect();
                    return (
                      r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
                    );
                  })
                  .slice(0, 20)
                  .map((animation) => {
                    const effect = animation.effect;
                    const target = effect instanceof KeyframeEffect ? effect.target : null;
                    return {
                      state: animation.playState,
                      pending: animation.pending,
                      tag: target instanceof Element ? target.tagName : null,
                      box:
                        target instanceof Element ? target.getBoundingClientRect().toJSON() : null,
                      keys:
                        effect instanceof KeyframeEffect
                          ? [
                              ...new Set(
                                effect.getKeyframes().flatMap((frame) => Object.keys(frame)),
                              ),
                            ].filter(
                              (key) =>
                                !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
                            )
                          : [],
                    };
                  }),
              ),
            });
            if (observation.changes.length > 40) observation.changes.shift();
          }
        }
        previous = fingerprint;
        if (
          ['ready', 'unsupported', 'error'].includes(state?.status ?? '') &&
          requests.every((request) => request.finished) &&
          Date.now() - stableSince >= 1000
        ) {
          await screenshot(label);
          state = await read();
          // Capture can span an asynchronous discovery/stream update. Accept only a frame
          // whose after-capture state still matches the terminal snapshot, not an old ready.
          if (JSON.stringify({ requests: requests.length, state }) !== fingerprint) continue;
          settled = true;
          break;
        }
        await page.waitForTimeout(300);
        state = await read();
      }
      stages.push({ label, requests: requests.length, settled, state });
      console.log(
        label,
        JSON.stringify({
          status: state?.status,
          texts: state?.texts.length,
          requests: requests.length,
          settled,
        }),
      );
      if (!settled) await screenshot(label);
      // A declared user-equivalent recovery stage, not a product automatic retry. Preserve
      // the failed stage/screenshot and permit at most one explicit format-error retry.
      if (
        !settled &&
        state?.status === 'error' &&
        state.notice?.includes('text/TRANSLATION_RESPONSE_INVALID') &&
        process.env.CHATBROWSERX_LENS_RETRY_FORMAT_ERRORS === '1' &&
        !label.endsWith('-format-retry')
      ) {
        await clickTranslationAction(page, session.sidePanelPage, target.tabId);
        return settle(`${label}-format-retry`);
      }
      if (!settled) throw new Error(`${label} did not reach a quiet terminal rendering state.`);
      return state;
    };
    const toggles: unknown[] = [];
    const toggle = async () => {
      const result = await runtime.send({
        version: 1,
        requestId: crypto.randomUUID(),
        type: 'translation.toggle',
        payload: { tabId: target.tabId },
      });
      toggles.push({ at: Date.now(), result, state: await read() });
      if (!result || typeof result !== 'object' || !('active' in result) || result.active !== true)
        throw new Error('Opening the translation lens did not return active:true.');
      return result;
    };
    let sourceChanges: unknown;
    let stability: unknown;
    let scrolling: unknown;
    let horizontalMovement: unknown;
    let timings: unknown;
    let responseShapes: unknown;
    let streamShapes: unknown;
    let aborts: unknown;
    let sourceLayout: unknown;
    let sourceAnimations: unknown;
    let mirrorLayout: unknown;
    const originalZoom = await session.sidePanelPage.evaluate(
      (tabId) => chrome.tabs.getZoom(tabId),
      target.tabId,
    );
    const setZoom = (factor: number) =>
      session.sidePanelPage.evaluate(({ tabId, factor }) => chrome.tabs.setZoom(tabId, factor), {
        tabId: target.tabId,
        factor,
      });
    // Diagnostic-only timings: no document text, request bodies or credentials are retained.
    await session.serviceWorker.evaluate(`(() => {
      const parse=JSON.parse,shapes=new Map(),events=[];
      const abort=AbortController.prototype.abort,aborts=[];
      AbortController.prototype.abort=function(reason){if(aborts.length<100)aborts.push({at:Date.now(),reason:reason?.name,stack:new Error().stack?.split("\\n").slice(1,6)});return abort.call(this,reason);};
      globalThis.__translationAborts=()=>{AbortController.prototype.abort=abort;return aborts;};
      const token=value=>typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(value)?value:undefined;
      JSON.parse=function(...args){
        const value=parse.apply(JSON,args);
        if((value?.type?.startsWith('response.')||value?.type==='error')&&events.length<5000){
          events.push({at:Date.now(),type:token(value.type),itemType:token(value.item?.type),
            status:token(value.response?.status),code:token(value.code??value.error?.code??value.response?.error?.code),
            codePath:value.code!=null?'code':value.error?.code!=null?'error.code':value.response?.error?.code!=null?'response.error.code':undefined,
            itemId:typeof value.item_id==='string',responseId:typeof value.response?.id==='string',
            outputIndex:value.output_index,contentIndex:value.content_index,
            deltaChars:typeof value.delta==='string'?value.delta.length:undefined});
        }
        if(Array.isArray(value?.blocks)&&value.blocks.length&&shapes.size<100){
          const blocks=value.blocks.map(block=>({id:block?.id,chars:typeof block?.translation==='string'?block.translation.length:null,hanChars:typeof block?.translation==='string'?(block.translation.match(/[\\u3400-\\u9fff]/g)??[]).length:null,tokens:typeof block?.translation==='string'?(block.translation.match(/<\\/?m\\d+>/g)??[]):[]}));
          shapes.set(String(blocks[0]?.id),blocks);
        }
        return value;
      };
      globalThis.__translationResponseShapes=()=>{JSON.parse=parse;return [...shapes.values()];};
      globalThis.__translationStreamShapes=()=>events;
      const original=chrome.tabs.sendMessage;
      const probes=[];
      chrome.tabs.sendMessage=async function(...args){
        if(!args[1]?.type?.startsWith('page.')) return original.apply(chrome.tabs,args);
        const record={at:Date.now(),type:args[1].type};if(probes.length<1000)probes.push(record);
        const start=performance.now();
        try { const reply=await original.apply(chrome.tabs,args);
          record.ok=reply?.ok;record.correlated=reply?.requestId===args[1].requestId;
          record.hasSession=typeof reply?.data?.sessionId==='string';record.active=reply?.data?.active;return reply;
        } catch(error){record.error=error?.name;throw error;}
        finally{record.duration=performance.now()-start;}
      };
      globalThis.__translationPortTimings=()=>{chrome.tabs.sendMessage=original;return probes;};
    })()`);
    await page.evaluate(`(() => {
      const tasks=[];
      const lifecycle=[];
      const track=(event)=>{if(lifecycle.length<100)lifecycle.push({at:Date.now(),type:event.type,hidden:document.hidden,focused:document.hasFocus()});};
      for(const type of ['visibilitychange','pagehide','focus','blur'])addEventListener(type,track,true);
      const observer=new PerformanceObserver(list=>{
        for(const entry of list.getEntries())if(tasks.length<1000)tasks.push({at:performance.timeOrigin+entry.startTime,duration:entry.duration});
      });
      observer.observe({type:'longtask'});
      globalThis.__translationTaskTimings=()=>{observer.disconnect();for(const type of ['visibilitychange','pagehide','focus','blur'])removeEventListener(type,track,true);return {tasks,lifecycle};};
    })()`);
    await runDiagnostic({
      run: async () => {
        await runtime.send({
          version: 1,
          requestId: crypto.randomUUID(),
          type: 'settings.save',
          payload: { ...saved, language: language as 'en' | 'zh-CN' },
        });
        await page.setViewportSize({ width: viewportWidth, height: 900 });
        await page.bringToFront();
        // Third-party ads/embeds may never finish loading. Canonical readiness plus
        // stable visible text, fonts and geometry below define the visual baseline.
        await page.waitForLoadState('domcontentloaded', {
          timeout: scenario.readinessTimeoutMs,
        });
        const layoutStarted = Date.now();
        let sourcePrevious = '',
          sourceStableSince = Date.now();
        // Canonical readiness permits an interactive document. A visual baseline also needs
        // its fonts/hydrated layout to settle before recording the source and applying the lens.
        for (;;) {
          const sourceLayout = await page.evaluate(() => ({
            fonts: document.fonts.status,
            height: document.documentElement.scrollHeight,
            textLength: document.body.innerText.length,
          }));
          const fingerprint = JSON.stringify(sourceLayout);
          if (fingerprint !== sourcePrevious) sourceStableSince = Date.now();
          sourcePrevious = fingerprint;
          if (sourceLayout.fonts === 'loaded' && Date.now() - sourceStableSince >= 600) break;
          if (Date.now() - layoutStarted >= scenario.readinessTimeoutMs)
            throw new Error('Source layout did not settle before the visual baseline.');
          await page.waitForTimeout(200);
        }
        // Virtualized documents mount distant sections only after their visible TOC is used.
        // This is an explicit diagnostic navigation step, never an editor or source-DOM write.
        if (navigationText) await page.getByText(navigationText, { exact: true }).click();
        if (anchor)
          await page
            .getByText(anchor, { exact: true })
            .first()
            .evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        else await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
        // Explicit native-popup regression: focus/open suggestions without typing,
        // submitting a query or changing the user's input value.
        if (process.env.CHATBROWSERX_LENS_FOCUS_TEXT_INPUT === '1') {
          const input = page
            .locator(
              'input:not([type]):visible,input[type=text]:visible,input[type=search]:visible',
            )
            .first();
          await input.click();
          await page.keyboard.press('ArrowDown');
        }
        sourceAnimations = await page.evaluate(() =>
          document
            .getAnimations()
            .slice(0, 40)
            .map((animation) => {
              const effect = animation.effect;
              const target = effect instanceof KeyframeEffect ? effect.target : null;
              return {
                state: animation.playState,
                tag: target?.tagName,
                classes: target?.getAttribute('class')?.slice(0, 240),
                box: target?.getBoundingClientRect().toJSON(),
                properties:
                  effect instanceof KeyframeEffect
                    ? [...new Set(effect.getKeyframes().flatMap(Object.keys))]
                    : [],
              };
            }),
        );
        await page.mouse.move(900, 450);
        await screenshot('source');
        // Retain references only in the page. Private text is neither returned nor written to JSON.
        const originals = await page.evaluateHandle(() =>
          [...document.querySelectorAll('h1,h2,h3,p,td,th,a,span')]
            .filter((el) => !el.closest('script,style,[data-chatbrowserx-overlay]'))
            .map((el) => ({
              el,
              text: el.textContent,
              parent: el.parentElement,
              parentText: el.parentElement?.textContent,
              style: el.getAttribute('style'),
              cellChildren: el.matches('td,th')
                ? [...el.querySelectorAll('*')].slice(0, 32).map((child) => ({
                    child,
                    text: child.textContent,
                    tag: child.tagName,
                    classes: child.getAttribute('class')?.slice(0, 120),
                    display: getComputedStyle(child).display,
                  }))
                : [],
            })),
        );
        const inspectText = process.env.CHATBROWSERX_LENS_INSPECT_TEXT;
        const inspectPoint = process.env.CHATBROWSERX_LENS_INSPECT_POINT?.split(',').map(Number);
        if (inspectText || (inspectPoint?.length === 2 && inspectPoint.every(Number.isFinite)))
          sourceLayout = await page.evaluate(
            ({ label, point }) => {
              const candidates = [
                ...document.querySelectorAll('a,span,li,div,ul,h1,h2,h3,h4,button'),
              ];
              const matches = candidates
                .filter((el) => {
                  const r = el.getBoundingClientRect();
                  const x = point?.[0] ?? 0,
                    y = point?.[1] ?? 0;
                  return (
                    (point?.length === 2
                      ? r.left <= x &&
                        r.right > x &&
                        r.top <= y &&
                        r.bottom > y &&
                        ![...el.children].some((child) => {
                          const b = child.getBoundingClientRect();
                          return b.left <= x && b.right > x && b.top <= y && b.bottom > y;
                        })
                      : !!label &&
                        el.textContent?.includes(label) &&
                        ![...el.children].some((child) => child.textContent?.includes(label))) &&
                    r.width > 0 &&
                    r.height > 0 &&
                    r.bottom > 0 &&
                    r.top < innerHeight &&
                    r.right > 0 &&
                    r.left < innerWidth
                  );
                })
                .slice(0, 4);
              return matches.map((el) => {
                const chain = [];
                for (
                  let node: Element | null = el;
                  node && chain.length < 12;
                  node = node.parentElement
                ) {
                  const style = getComputedStyle(node);
                  const typed = (
                    node as Element & {
                      computedStyleMap?(): Map<string, { toString(): string }>;
                    }
                  ).computedStyleMap?.();
                  chain.push({
                    tag: node.tagName,
                    box: node.getBoundingClientRect().toJSON(),
                    scrollWidth: node.scrollWidth,
                    clientWidth: node.clientWidth,
                    zoom: node.currentCSSZoom,
                    children: node.childElementCount,
                    textEdges: [...node.childNodes]
                      .filter((child) => child.nodeType === Node.TEXT_NODE)
                      .map((child) => ({
                        chars: child.textContent?.length ?? 0,
                        leading: child.textContent?.match(/^\s*/)?.[0] ?? '',
                        trailing: child.textContent?.match(/\s*$/)?.[0] ?? '',
                      })),
                    items: [...node.children].slice(0, 40).map((child) => {
                      const css = getComputedStyle(child);
                      return {
                        tag: child.tagName,
                        children: child.childElementCount,
                        box: child.getBoundingClientRect().toJSON(),
                        textLength: child.textContent?.trim().length,
                        display: css.display,
                        float: css.float,
                        position: css.position,
                        transform: css.transform,
                        translate: css.translate,
                        rotate: css.rotate,
                        scale: css.scale,
                        width: css.width,
                        height: css.height,
                        lineHeight: css.lineHeight,
                        whiteSpace: css.whiteSpace,
                        overflow: css.overflow,
                        fontSize: css.fontSize,
                        margin: css.margin,
                        flex: css.flex,
                        textRects: [...child.childNodes]
                          .flatMap((n) => {
                            const range = document.createRange();
                            range.selectNodeContents(n);
                            return [...range.getClientRects()].map((r) => r.toJSON());
                          })
                          .slice(0, 24),
                        descendants: [...child.children].slice(0, 8).map((c) => ({
                          tag: c.tagName,
                          box: c.getBoundingClientRect().toJSON(),
                          display: getComputedStyle(c).display,
                        })),
                      };
                    }),
                    hidden: node.hasAttribute('hidden'),
                    inert: node.hasAttribute('inert'),
                    ariaHidden: node.getAttribute('aria-hidden'),
                    editable: node.getAttribute('contenteditable'),
                    animations: node.getAnimations().map((a) => a.playState),
                    background: {
                      image: style.backgroundImage !== 'none',
                      position: style.backgroundPosition,
                      size: style.backgroundSize,
                      repeat: style.backgroundRepeat,
                    },
                    sizing: Object.fromEntries(
                      ['height', 'max-height', 'aspect-ratio'].map((key) => [
                        key,
                        typed?.get(key)?.toString(),
                      ]),
                    ),
                    boundaries: [...node.querySelectorAll('*')]
                      .filter((child) => {
                        const s = getComputedStyle(child);
                        return (
                          child.matches(
                            'canvas,video,iframe,object,embed,input,textarea,select,[role="textbox"]',
                          ) ||
                          child.shadowRoot ||
                          child
                            .getAnimations()
                            .some((a) => a.playState === 'running' || a.pending) ||
                          (s.position !== 'static' &&
                            /^(hidden|clip)$/.test(s.overflowX) &&
                            /^(hidden|clip)$/.test(s.overflowY))
                        );
                      })
                      .slice(0, 24)
                      .map((child) => ({
                        tag: child.tagName,
                        role: child.getAttribute('role'),
                        shadow: !!child.shadowRoot,
                        box: child.getBoundingClientRect().toJSON(),
                        textChars: child.textContent?.length ?? 0,
                        css: Object.fromEntries(
                          ['display', 'position', 'overflow', 'visibility', 'opacity'].map(
                            (key) => [key, getComputedStyle(child).getPropertyValue(key)],
                          ),
                        ),
                        animations: child.getAnimations().map((a) => a.playState),
                        children: [...child.children].slice(0, 8).map((el) => ({
                          tag: el.tagName,
                          position: getComputedStyle(el).position,
                          textChars: el.textContent?.length ?? 0,
                        })),
                      })),
                    css: Object.fromEntries(
                      [
                        'display',
                        'float',
                        'position',
                        'width',
                        'min-width',
                        'max-width',
                        'box-sizing',
                        'padding-left',
                        'padding-right',
                        'height',
                        'line-height',
                        'font-size',
                        'white-space',
                        'overflow',
                        'text-overflow',
                        'text-align',
                        'flex-wrap',
                        'flex-direction',
                        'justify-content',
                        'align-items',
                        'align-content',
                        'column-gap',
                        'margin-left',
                        'margin-right',
                        'margin-top',
                        'margin-bottom',
                        'transform',
                        'translate',
                        'rotate',
                        'scale',
                        'filter',
                        'mix-blend-mode',
                        'visibility',
                        'opacity',
                        'clip-path',
                      ].map((key) => [key, style.getPropertyValue(key)]),
                    ),
                  });
                }
                return chain;
              });
            },
            { label: inspectText, point: inspectPoint },
          );
        if (process.env.CHATBROWSERX_LENS_SOURCE_ONLY === '1') return;
        await toggle();
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -5000);
        await page.keyboard.up('Control');
        const initial = await settle('initial');
        if (initial?.status === 'error')
          throw new Error('Initial translation failed; see local evidence.json before retrying.');
        if (anchor && process.env.CHATBROWSERX_LENS_SELECT_BEFORE_REFRESH === '1')
          await page.getByText(anchor, { exact: true }).first().dblclick();
        const beforeRefresh = requests.length;
        await page.keyboard.press('Alt+KeyR');
        const refreshed = await settle('manual-refresh');
        if (refreshed?.status === 'error')
          throw new Error('Manual refresh failed; see local evidence.json before retrying.');
        if (
          initial?.texts.some(
            (text) =>
              (text.box.right ?? 0) > 0 &&
              (text.box.bottom ?? 0) > 0 &&
              (text.box.left ?? Infinity) < viewportWidth &&
              (text.box.top ?? Infinity) < 900,
          ) &&
          requests.length <= beforeRefresh
        )
          throw new Error('Manual refresh did not submit current visible text again.');
        if (process.env.CHATBROWSERX_LENS_INITIAL_ONLY === '1') return;
        sourceChanges = await originals.evaluate((rows) => ({
          count: rows.length,
          disconnected: rows.filter((r) => !r.el.isConnected).length,
          text: rows.filter((r) => r.el.isConnected && r.text !== r.el.textContent).length,
          style: rows.filter((r) => r.el.isConnected && r.style !== r.el.getAttribute('style'))
            .length,
          styleChanges: rows
            .filter((r) => r.el.isConnected && r.style !== r.el.getAttribute('style'))
            .slice(0, 20)
            .map((r) => {
              const previous = document.createElement('span').style;
              previous.cssText = r.style ?? '';
              const current = (r.el as HTMLElement).style;
              return {
                tag: r.el.tagName,
                classes: r.el.getAttribute('class')?.slice(0, 160),
                properties: [...new Set([...previous, ...current])].filter(
                  (p) => previous.getPropertyValue(p) !== current.getPropertyValue(p),
                ),
              };
            }),
          // Page-owned hydration/tooltips may change the broad source snapshot. Keep
          // bounded, text-free identities so that this is not mislabeled a source edit.
          textChanges: rows
            .filter((r) => r.el.isConnected && r.text !== r.el.textContent)
            .slice(0, 20)
            .map((r) => ({
              tag: r.el.tagName,
              classes: r.el.getAttribute('class')?.slice(0, 160),
              parentClasses: r.el.parentElement?.getAttribute('class')?.slice(0, 160),
              beforeChars: r.text?.length ?? 0,
              afterChars: r.el.textContent?.length ?? 0,
              normalizedSame:
                r.text?.replace(/[\s\u200b]/g, '') === r.el.textContent?.replace(/[\s\u200b]/g, ''),
              parentTextSame: r.parentText === r.parent?.textContent,
              ...(r.cellChildren.length
                ? {
                    children: r.cellChildren.map(({ child, text, ...metadata }) => ({
                      ...metadata,
                      connected: child.isConnected,
                      stillInCell: r.el.contains(child),
                      beforeChars: text?.length ?? 0,
                      afterChars: child.textContent?.length ?? 0,
                      textSame: text === child.textContent,
                    })),
                  }
                : {}),
            })),
        }));
        await originals.dispose();
        // Match existing mirror origins to source boxes once, then measure geometry after
        // actual wheel events AND in animation frames. Stationary screenshots cannot detect
        // a fixed translation surface lagging behind the browser's scrolling content.
        await session.sidePanelPage.evaluate(`(async () => {
        await chrome.scripting.executeScript({target:{tabId:${target.tabId}},func:()=>{
          const host=document.querySelector('[data-chatbrowserx-overlay=translation]');
          const shadow=host&&chrome.dom.openOrClosedShadowRoot(host);
          const groups=[...(shadow?.querySelectorAll('.translation-group')??[])];
          const sources=[...document.querySelectorAll('*')].filter(el=>!el.closest('[data-chatbrowserx-overlay]')).map(el=>({el,box:el.getBoundingClientRect()}));
          const motionRoot=el=>{
            for(let node=el;node;node=node.parentElement){
              const style=getComputedStyle(node);
              if(['fixed','sticky'].includes(style.position)||
                (/^(auto|scroll)$/.test(style.overflowY)&&node.scrollHeight>node.clientHeight+1))return node;
            }
            return document.scrollingElement;
          };
          let ambiguous=0;
          const pairs=groups.flatMap(group=>{
            const box=group.getBoundingClientRect();
            const height=parseFloat(group.style.minHeight);
            const candidates=sources.filter(({box:r})=>Math.abs(r.x-box.x)<.1&&Math.abs(r.y-box.y)<.1&&Math.abs(r.width-box.width)<1&&Math.abs(r.height-height)<1);
            // Equal rectangles can belong to a static placeholder and a fixed child.
            // Do not turn an ambiguous source match into a claimed scrolling defect/pass.
            if(new Set(candidates.map(({el})=>motionRoot(el))).size>1){ambiguous++;return [];}
            const source=candidates.find(({el})=>el.tagName===group.children[1]?.tagName)??candidates.at(-1);
            return source?[{group,source:source.el,x:box.x-source.box.x,y:box.y-source.box.y,maxOffset:0}]:[];
          });
          const result={groups:groups.length,matched:pairs.length,ambiguous,unmatched:groups.length-pairs.length-ambiguous,frames:0,scrollEvents:0,offsetFrames:0,offsetEvents:0,maxFrameOffset:0,maxEventOffset:0,maxFrameGapMs:0,replacements:0,pairs:[]};
          let animation=0,previous=performance.now();
          const measure=()=>Math.max(0,...pairs.filter(p=>p.source.isConnected&&p.group.isConnected).map(p=>{
            const s=p.source.getBoundingClientRect(),g=p.group.getBoundingClientRect();
            const offset=Math.max(Math.abs(g.x-s.x-p.x),Math.abs(g.y-s.y-p.y));
            p.maxOffset=Math.max(p.maxOffset,offset);return offset;
          }));
          const onScroll=()=>{result.scrollEvents++;const offset=measure();if(offset>1)result.offsetEvents++;result.maxEventOffset=Math.max(result.maxEventOffset,offset);};
          const tick=time=>{result.frames++;result.maxFrameGapMs=Math.max(result.maxFrameGapMs,time-previous);previous=time;
            const offset=measure();if(offset>1)result.offsetFrames++;result.maxFrameOffset=Math.max(result.maxFrameOffset,offset);
            animation=requestAnimationFrame(tick);
          };
          window.addEventListener('scroll',onScroll,true);animation=requestAnimationFrame(tick);
          globalThis.__translationScrollProbe=()=>{cancelAnimationFrame(animation);window.removeEventListener('scroll',onScroll,true);
            result.pairs=pairs.map(p=>({source:p.source.tagName,motion:motionRoot(p.source)?.tagName,position:getComputedStyle(p.source).position,maxOffset:p.maxOffset}));
            result.replacements=pairs.filter(p=>!p.group.isConnected).length;return result;};
        }});
      })()`);
        for (let cycle = 0; cycle < 2; cycle++)
          for (const direction of [1, -1])
            for (let step = 0; step < 8; step++) {
              await page.mouse.wheel(0, 24 * direction);
              await page.waitForTimeout(20);
            }
        scrolling = await session.sidePanelPage.evaluate(`(async () => {
        const [result]=await chrome.scripting.executeScript({target:{tabId:${target.tabId}},func:()=>{
          const result=globalThis.__translationScrollProbe?.();delete globalThis.__translationScrollProbe;return result;
        }});return result?.result;
      })()`);
        console.log('continuous-scroll', JSON.stringify(scrolling));
        await settle('continuous-scroll-back');
        await page.mouse.wheel(0, 280);
        await settle('scroll-down');
        await page.mouse.wheel(0, -280);
        await settle('scroll-back');
        const horizontal = await page.evaluateHandle(() => {
          const el = [...document.querySelectorAll<HTMLElement>('*')].find((node) => {
            const r = node.getBoundingClientRect();
            return (
              !node.closest('[data-chatbrowserx-overlay]') &&
              /^(auto|scroll)$/.test(getComputedStyle(node).overflowX) &&
              node.scrollWidth > node.clientWidth + 2 &&
              r.width > 0 &&
              r.height > 0 &&
              r.bottom > 0 &&
              r.top < innerHeight
            );
          });
          return el ? { el, left: el.scrollLeft } : null;
        });
        if (await horizontal.evaluate((port) => Boolean(port))) {
          try {
            await horizontal.evaluate((port) => {
              if (port) port.el.scrollLeft += 240;
            });
            await settle('horizontal-scroll');
            horizontalMovement = await horizontal.evaluate((port) =>
              port
                ? {
                    kind: 'scrollport',
                    before: port.left,
                    after: port.el.scrollLeft,
                  }
                : null,
            );
          } finally {
            await horizontal.evaluate((port) => {
              if (port) port.el.scrollLeft = port.left;
            });
          }
          await settle('horizontal-back');
        } else {
          // Some document apps pan wide tables with their own wheel handler instead of a
          // native overflow:auto element. Exercise that browser gesture without site rules.
          const point = await page.evaluate(() => {
            for (const [index, table] of [...document.querySelectorAll('table')].entries()) {
              const r = table.getBoundingClientRect();
              if (
                r.height > 60 &&
                r.bottom > 100 &&
                r.top < innerHeight - 100 &&
                r.right > 0 &&
                r.left < innerWidth
              )
                return {
                  index,
                  left: r.left,
                  x: Math.max(30, Math.min(innerWidth - 30, r.left + 80)),
                  y: Math.max(100, Math.min(innerHeight - 100, r.top + r.height / 2)),
                };
            }
            return null;
          });
          if (point) {
            await page.mouse.move(point.x, point.y);
            await page.mouse.wheel(240, 0);
            await settle('horizontal-scroll');
            horizontalMovement = await page.evaluate(({ index, left }) => {
              const table = document.querySelectorAll('table')[index];
              return {
                kind: 'wheel',
                before: left,
                after: table?.getBoundingClientRect().left,
              };
            }, point);
            await page.mouse.wheel(-240, 0);
            await settle('horizontal-back');
          }
        }
        await horizontal.dispose();
        await page.keyboard.press('Escape');
        await toggle();
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -5000);
        await page.keyboard.up('Control');
        await settle('cached-reopen');
        stability = await session.sidePanelPage.evaluate(`(async () => {
        const [result]=await chrome.scripting.executeScript({target:{tabId:${target.tabId}},func:async()=>{
          const host=document.querySelector('[data-chatbrowserx-overlay=translation]');
          const root=host&&chrome.dom.openOrClosedShadowRoot(host);
          let previous=[...(root?.querySelectorAll('.translation-group')??[])];
          const started=performance.now();let frames=0,hidden=0,replacements=0;
          const mutations=[];
          const observer=new MutationObserver(records=>{
            for(const record of records){
              const node=record.target instanceof Element?record.target:record.target.parentElement;
              if(!node||node.closest('[data-chatbrowserx-overlay]')||mutations.length>=100)continue;
              const s=getComputedStyle(node),r=node.getBoundingClientRect();
              mutations.push({type:record.type,attribute:record.attributeName,tag:node.tagName,
                box:r.toJSON(),display:s.display,position:s.position,visible:r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight,
                children:node.childElementCount,added:record.addedNodes.length,removed:record.removedNodes.length});
            }
          });
          observer.observe(document.documentElement,{childList:true,attributes:true,characterData:true,subtree:true});
          while(performance.now()-started<2000){await new Promise(requestAnimationFrame);frames++;
            if(!host?.isConnected||getComputedStyle(host).visibility==='hidden')hidden++;
            const current=[...(root?.querySelectorAll('.translation-group')??[])];
            if(current.length!==previous.length||current.some((el,i)=>el!==previous[i]))replacements++;
            previous=current;
          }
          observer.disconnect();
          return {frames,hidden,replacements,mutations};
        }});return result?.result;
      })()`);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, 180);
        await page.keyboard.up('Control');
        await settle('resized-lens');
        await page.mouse.move(600, 400, { steps: 12 });
        await settle('moved-lens');
        await setZoom(1.25);
        await settle('browser-zoom-125');
        await setZoom(originalZoom);
        await settle('browser-zoom-restored');
        // Some pages rebuild their source widgets on viewport changes. Under the
        // manual-update policy, exercise recovery rather than relying on reopen.
        await page.keyboard.press('Alt+KeyR');
        const afterZoom = await settle('manual-refresh-after-zoom');
        if (afterZoom?.status === 'error')
          throw new Error('Manual refresh after zoom failed; see local evidence.json.');
        for (let attempt = 1; attempt <= 3; attempt++) {
          await page.keyboard.press('Escape');
          await toggle();
          await settle(`reopen-${attempt}`);
        }
      },
      cleanup: [
        ['zoom', () => setZoom(originalZoom)],
        [
          'probes',
          async () => {
            const point = process.env.CHATBROWSERX_LENS_INSPECT_POINT?.split(',').map(Number);
            const inspectedIds = requests.flatMap((request) => request.inspectedIds ?? []);
            if (inspectedIds.length || (point?.length === 2 && point.every(Number.isFinite)))
              mirrorLayout = await session.sidePanelPage.evaluate(`(async () => {
                const [result]=await chrome.scripting.executeScript({target:{tabId:${target.tabId}},func:()=>{
                  const host=document.querySelector('[data-chatbrowserx-overlay=translation]');
                  const root=host&&chrome.dom.openOrClosedShadowRoot(host);
                  const point=${JSON.stringify(point)};
                  const inspectedIds=${JSON.stringify(inspectedIds)};
                  return [...(root?.querySelectorAll(point?'*':'[data-translation-id]')??[])].filter(el=>{
                    if(inspectedIds.includes(el.dataset.translationId))return true;
                    const r=el.getBoundingClientRect();
                    return point&&r.left<=point[0]&&r.right>point[0]&&r.top<=point[1]&&r.bottom>point[1]&&
                      ![...el.children].some(child=>{const b=child.getBoundingClientRect();return b.left<=point[0]&&b.right>point[0]&&b.top<=point[1]&&b.bottom>point[1];});
                  }).slice(0,16).map(el=>{
                    const chain=[];
                    for(let node=el;node&&chain.length<7;node=node.parentElement){
                      const s=getComputedStyle(node);
                      chain.push({tag:node.tagName,box:node.getBoundingClientRect().toJSON(),css:Object.fromEntries(['display','position','width','min-width','max-width','box-sizing','padding-left','padding-right','overflow','text-overflow','white-space','flex','flex-wrap','align-items','align-content','margin-left','margin-right','margin-top','margin-bottom'].map(key=>[key,s.getPropertyValue(key)]))});
                    }
                    const descendants=[el,...el.querySelectorAll('*')].slice(0,32).map(node=>{
                      const s=getComputedStyle(node);
                      return {tag:node.tagName,box:node.getBoundingClientRect().toJSON(),css:Object.fromEntries(['display','position','width','min-width','max-width','white-space','overflow','text-overflow'].map(key=>[key,s.getPropertyValue(key)])),text:[...node.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>({chars:n.textContent.length,newlines:n.textContent.split(String.fromCharCode(10)).map(line=>line.length)}))};
                    });
                    return {id:el.dataset.translationId,chain,descendants};
                  });
                }});return result?.result;
              })()`);
            responseShapes = await session.serviceWorker
              .evaluate('globalThis.__translationResponseShapes?.()')
              .catch(() => null);
            streamShapes = await session.serviceWorker
              .evaluate('globalThis.__translationStreamShapes?.()')
              .catch(() => null);
            aborts = await session.serviceWorker
              .evaluate('globalThis.__translationAborts?.()')
              .catch(() => null);
            timings = {
              pageQueries: await session.serviceWorker
                .evaluate('globalThis.__translationPortTimings?.()')
                .catch(() => null),
              longTasks: await page
                .evaluate('globalThis.__translationTaskTimings?.()')
                .catch(() => null),
            };
          },
        ],
        ['lens', () => page.keyboard.press('Escape')],
        [
          'settings',
          async () => {
            await runtime.send({
              version: 1,
              requestId: crypto.randomUUID(),
              type: 'settings.save',
              payload: saved,
            });
          },
        ],
        [
          'source-screenshot',
          async () => {
            await screenshot('source-after');
          },
        ],
        ['screenshot-session', () => screenshotSession.detach()],
      ],
      persist: async (failures) => {
        await writeFile(
          join(output, 'evidence.json'),
          JSON.stringify(
            {
              kind: 'native-lens-diagnostic',
              mode:
                process.env.CHATBROWSERX_LENS_SOURCE_ONLY === '1'
                  ? 'source-only'
                  : process.env.CHATBROWSERX_LENS_INITIAL_ONLY === '1'
                    ? 'initial-only'
                    : 'interaction-matrix',
              viewport: { width: viewportWidth, height: 900 },
              formatRetryPolicy:
                process.env.CHATBROWSERX_LENS_RETRY_FORMAT_ERRORS === '1'
                  ? 'one-explicit-action-per-stage; failed stage retained'
                  : 'none',
              productTarget,
              readiness,
              requests,
              responseShapes,
              streamShapes,
              aborts,
              stages,
              settling,
              sourceChanges,
              horizontalMovement,
              sourceLayout,
              sourceAnimations,
              mirrorLayout,
              stability,
              scrolling,
              timings,
              navigations,
              toggles,
              failures,
            },
            null,
            2,
          ),
        );
      },
    });
  },
);
