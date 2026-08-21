import { describe, expect, it } from 'vitest';
import {
  getLiveScenario,
  listLiveScenarios,
  parseLiveScenarioName,
  validateLiveScenarioAuthorization,
  validateReadOnlyScenario,
} from '../../../scripts/live-e2e/scenarios';

describe('live E2E scenario registry', () => {
  it('registers one read-only structural five-group Feishu messenger scenario', () => {
    const scenario = getLiveScenario('lark-messenger-read');

    expect(scenario.allowRemoteMutation).toBe(false);
    expect(scenario.startUrl).toBe('https://bytedance.larkoffice.com/next/messenger');
    expect(scenario.expectedOrigin).toBe('https://bytedance.larkoffice.com');
    expect(scenario.requiredTools).toContain('browser_inspect');
    expect(scenario.forbidScreenshotInspect).toBe(true);
    expect(scenario.forbidSubmittedType).toBe(true);
    expect(scenario.forbiddenTools).toEqual(
      expect.arrayContaining([
        'browser_click_point',
        'browser_drag_point',
        'browser_network_start',
        'browser_network_list',
        'browser_network_get',
        'browser_network_stop',
      ]),
    );
    expect(scenario.finalTextIncludes).toEqual(expect.arrayContaining(['群聊', '最近24小时']));
    expect(scenario.minimumMarkdownTableRows).toBe(5);
    expect(scenario.taskText).toContain('5 个');
    expect(scenario.taskText).toContain('不要发送消息');
  });

  it('registers one read-only full-month messenger history regression scenario', () => {
    const scenario = getLiveScenario('lark-messenger-august-history');

    expect(scenario.allowRemoteMutation).toBe(false);
    expect(scenario.requiredTools).toEqual(
      expect.arrayContaining(['browser_inspect', 'browser_scroll']),
    );
    expect(scenario.forbidScreenshotInspect).toBe(true);
    expect(scenario.forbidSubmittedType).toBe(true);
    expect(scenario.forbiddenTools).toEqual(
      expect.arrayContaining(['browser_click_point', 'browser_drag_point']),
    );
    expect(scenario.taskText).toContain('豆包*飞书C360管');
    expect(scenario.taskText).toContain('2026 年 8 月');
    expect(scenario.taskText).toContain('boundaryVerified=true');
    expect(scenario.finalTextIncludes).toEqual(
      expect.arrayContaining(['豆包*飞书C360管', '8 月', '覆盖边界']),
    );
  });

  it('registers one read-only multi-group history scrolling regression scenario', () => {
    const scenario = getLiveScenario('lark-messenger-multi-group-scroll');

    expect(scenario.allowRemoteMutation).toBe(false);
    expect(scenario.requiredTools).toEqual(
      expect.arrayContaining(['browser_inspect', 'browser_click', 'browser_scroll']),
    );
    expect(scenario.forbidScreenshotInspect).toBe(true);
    expect(scenario.forbidSubmittedType).toBe(true);
    expect(scenario.taskText).toContain('3 个不同的真实群聊');
    expect(scenario.taskText).toContain('每个群聊至少调用一次 browser_scroll');
    expect(scenario.minimumMarkdownTableRows).toBe(3);
  });

  it('lists stable scenario names without exposing a mutable registry', () => {
    const scenarios = listLiveScenarios();

    expect(scenarios.map(({ name }) => name)).toEqual([
      'lark-messenger-read',
      'lark-messenger-august-history',
      'lark-messenger-multi-group-scroll',
      'lark-self-send',
      'lark-self-send-screenshot',
      'lark-five-groups-summary-screenshot-send',
      'lark-calendar-mail-screenshot',
      'lark-existing-calendar-mail-screenshot',
      'lark-sent-mail-image-readback',
    ]);
    expect(() => (scenarios as unknown[]).push({})).toThrow();
  });

  it('registers one standalone calendar and screenshot-mail scenario with bounded mutations', () => {
    const scenario = getLiveScenario('lark-calendar-mail-screenshot');

    expect(scenario.allowRemoteMutation).toBe(true);
    expect(scenario.startUrl).toBe('https://bytedance.larkoffice.com/next/messenger');
    expect(scenario.expectedOrigin).toBe('https://bytedance.larkoffice.com');
    expect(scenario.requiredTools).toEqual(
      expect.arrayContaining([
        'browser_inspect',
        'browser_click',
        'browser_type',
        'browser_capture_screenshot',
        'browser_paste_image',
      ]),
    );
    expect(scenario.requiredTools).not.toContain('browser_click_point');
    expect(scenario.expectedToolCounts).toMatchObject({
      browser_capture_screenshot: 1,
      browser_paste_image: 1,
    });
    expect(scenario.expectedToolCounts).not.toHaveProperty('browser_click_point');
    expect(scenario.requiredVerifiedTools).toEqual(expect.arrayContaining(['browser_paste_image']));
    expect(scenario.maxAttachmentCount).toBe(1);
    expect(scenario.forbidScreenshotInspect).toBe(true);
    expect(scenario.forbiddenTools).toContain('browser_click_point');
    expect(scenario.taskText).toContain('2026-08-21');
    expect(scenario.taskText).toContain('16:00');
    expect(scenario.taskText).toContain('16:30');
    expect(scenario.taskText).toContain('独立日程');
    expect(scenario.taskText).toContain('caoyang.001');
    expect(scenario.taskText).toContain('ChatBrowserX calendar self-check {{RUN_ID}}');
    expect(scenario.taskText).toContain('ChatBrowserX mail self-check {{RUN_ID}}');
    expect(scenario.taskText).toContain('interactive_deep');
    expect(scenario.taskText).toContain('优先使用可操作 ref');
    expect(scenario.taskText).toContain('禁止截图模式检查和坐标操作');
    expect(scenario.taskText).toContain('已发送');
    expect(scenario.finalTextExcludes).toEqual(
      expect.arrayContaining(['唯一阻塞点', '无法确认', 'could not verify']),
    );
  });

  it('registers one existing-calendar screenshot-mail recovery scenario without event mutation', () => {
    const scenario = getLiveScenario('lark-existing-calendar-mail-screenshot');

    expect(scenario.allowRemoteMutation).toBe(true);
    expect(scenario.taskText).toContain('不得新建、编辑、保存或删除日程');
    expect(scenario.taskText).toContain('ChatBrowserX calendar self-check live_');
    expect(scenario.taskText).toContain('ChatBrowserX mail self-check {{RUN_ID}}');
    expect(scenario.requiredTools).toEqual(
      expect.arrayContaining([
        'browser_inspect',
        'browser_click',
        'browser_type',
        'browser_capture_screenshot',
        'browser_paste_image',
      ]),
    );
    expect(scenario.expectedToolCounts).toMatchObject({
      browser_capture_screenshot: 1,
      browser_paste_image: 1,
    });
    expect(scenario.requiredVerifiedTools).toContain('browser_paste_image');
    expect(scenario.maxAttachmentCount).toBe(1);
    expect(scenario.forbidScreenshotInspect).toBe(true);
    expect(scenario.forbiddenTools).toEqual(
      expect.arrayContaining(['browser_click_point', 'browser_drag_point']),
    );
    expect(scenario.finalTextExcludes).toEqual(
      expect.arrayContaining(['唯一阻塞点', '无法确认', 'could not verify']),
    );
  });

  it('registers a read-only sent-mail image readback scenario', () => {
    const scenario = getLiveScenario('lark-sent-mail-image-readback');

    expect(scenario.allowRemoteMutation).toBe(false);
    expect(scenario.requiredTools).toEqual(
      expect.arrayContaining(['browser_inspect', 'browser_click']),
    );
    expect(scenario.forbidScreenshotInspect).toBe(true);
    expect(scenario.forbidSubmittedType).toBe(true);
    expect(scenario.forbiddenTools).toEqual(
      expect.arrayContaining([
        'browser_type',
        'browser_capture_screenshot',
        'browser_paste_image',
        'browser_click_point',
      ]),
    );
    expect(scenario.taskText).toContain('已发送');
    expect(scenario.taskText).toContain('ChatBrowserX mail self-check live_');
    expect(scenario.taskText).toContain('role=image');
    expect(scenario.finalTextExcludes).toEqual(
      expect.arrayContaining(['唯一阻塞点', '无法确认', 'could not verify']),
    );
  });

  it('registers one screenshot-to-Feishu delivery scenario with exact mutation tools', () => {
    const scenario = getLiveScenario('lark-self-send-screenshot');

    expect(scenario.allowRemoteMutation).toBe(true);
    expect(scenario.requiredTools).toEqual(
      expect.arrayContaining(['browser_capture_screenshot', 'browser_paste_image', 'browser_type']),
    );
    expect(scenario.expectedToolCounts).toMatchObject({
      browser_capture_screenshot: 1,
      browser_paste_image: 1,
    });
    expect(scenario.maxAttachmentCount).toBe(1);
    expect(scenario.taskText).toContain('caoyang.001');
    expect(scenario.taskText).toContain('{{RUN_ID}}');
  });

  it('registers one strict five-group summary and screenshot delivery scenario', () => {
    const scenario = getLiveScenario('lark-five-groups-summary-screenshot-send');

    expect(scenario.allowRemoteMutation).toBe(true);
    expect(scenario.requiredTools).toEqual(
      expect.arrayContaining([
        'browser_inspect',
        'browser_capture_screenshot',
        'browser_paste_image',
        'browser_type',
      ]),
    );
    expect(scenario.expectedToolCounts).toMatchObject({
      browser_capture_screenshot: 1,
      browser_paste_image: 1,
    });
    expect(scenario.expectedSubmittedTypeCount).toBe(2);
    expect(scenario.minimumMarkdownTableRows).toBe(5);
    expect(scenario.maxAttachmentCount).toBe(1);
    expect(scenario.taskText).toContain('5 个不同的真实群聊');
    expect(scenario.taskText).toContain('caoyang.001');
    expect(scenario.taskText).toContain('{{RUN_ID}}');
  });

  it('registers one explicitly authorized self-send scenario with verifiable output', () => {
    const scenario = getLiveScenario('lark-self-send');

    expect(scenario.allowRemoteMutation).toBe(true);
    expect(scenario.taskText).toContain('caoyang.001');
    expect(scenario.taskText).toContain('{{RUN_ID}}');
    expect(scenario.taskText).toContain('submit=true');
    expect(scenario.expectedSubmittedTypeCount).toBe(1);
    expect(scenario.requiredToolOutputIncludes?.some((value) => value.includes('{{RUN_ID}}'))).toBe(
      true,
    );
    expect(scenario.requiredTypedTextIncludes?.some((value) => value.includes('{{RUN_ID}}'))).toBe(
      true,
    );
  });

  it('rejects unknown names and mutation-capable scenarios', () => {
    expect(() => getLiveScenario('missing')).toThrow(/unknown live E2E scenario/i);
    const scenario = getLiveScenario('lark-messenger-read');
    expect(() => validateReadOnlyScenario({ ...scenario, allowRemoteMutation: true })).toThrow(
      /read-only/i,
    );
  });

  it('requires an explicit environment opt-in before running a mutation scenario', () => {
    const scenario = getLiveScenario('lark-self-send');

    expect(() => validateLiveScenarioAuthorization(scenario, {})).toThrow(/explicit opt-in/i);
    expect(() =>
      validateLiveScenarioAuthorization(scenario, {
        CHATBROWSERX_LIVE_ALLOW_MUTATION: '1',
      }),
    ).not.toThrow();
    expect(() =>
      validateLiveScenarioAuthorization(getLiveScenario('lark-messenger-read'), {}),
    ).not.toThrow();
  });

  it('accepts the standalone separator forwarded by pnpm package scripts', () => {
    expect(parseLiveScenarioName(['lark-messenger-read'])).toBe('lark-messenger-read');
    expect(parseLiveScenarioName(['--', 'lark-messenger-read'])).toBe('lark-messenger-read');
    expect(() => parseLiveScenarioName(['--'])).toThrow(/usage/i);
    expect(() => parseLiveScenarioName(['first', 'second'])).toThrow(/usage/i);
  });
});
