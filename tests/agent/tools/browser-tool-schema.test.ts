import { describe, expect, it } from 'vitest';
import {
  BROWSER_TOOL_DEFINITIONS,
  parseBrowserToolCall,
} from '../../../src/agent/tools/browser-tool-schema';

const CASES = [
  ['browser_get_current_tab', 'get_current_tab', 'safe', {}],
  ['browser_list_tabs', 'list_tabs', 'safe', {}],
  [
    'browser_open_tab',
    'open_tab',
    'mutation',
    { url: 'http://localhost:3000/app', activate: true },
  ],
  ['browser_switch_tab', 'switch_tab', 'safe', { tabId: 7 }],
  ['browser_close_tab', 'close_tab', 'mutation', { tabId: 7 }],
  ['browser_navigate', 'navigate', 'mutation', { tabId: 7, url: 'https://example.com/a' }],
  ['browser_reload', 'reload', 'mutation', { tabId: 7 }],
  ['browser_inspect', 'inspect', 'safe', { tabId: 7, mode: 'interactive', since: '' }],
  ['browser_capture_screenshot', 'capture_screenshot', 'safe', { tabId: 7 }],
  [
    'browser_paste_image',
    'paste_image',
    'mutation',
    { tabId: 7, ref: 'ref_1', assetId: 'attachment_1' },
  ],
  ['browser_click', 'click', 'mutation', { tabId: 7, ref: 'ref_1', button: 'left', count: 1 }],
  ['browser_set_checked', 'set_checked', 'mutation', { tabId: 7, ref: 'ref_1', checked: true }],
  [
    'browser_set_checked_many',
    'set_checked_many',
    'mutation',
    {
      tabId: 7,
      items: [
        { ref: 'ref_1', checked: true },
        { ref: 'ref_2', checked: false },
      ],
    },
  ],
  [
    'browser_type',
    'type',
    'mutation',
    { tabId: 7, ref: 'ref_1', text: 'hello', replace: true, submit: false },
  ],
  ['browser_keypress', 'keypress', 'mutation', { tabId: 7, keys: 'CTRL+L' }],
  [
    'browser_scroll',
    'scroll',
    'mutation',
    { tabId: 7, target: 'viewport', deltaX: 0, deltaY: 100 },
  ],
  [
    'browser_scroll_until',
    'scroll_until',
    'mutation',
    {
      tabId: 7,
      target: 'viewport',
      deltaX: 0,
      deltaY: -1_200,
      maxSegments: 16,
      stopText: '7月',
    },
  ],
  ['browser_hover', 'hover', 'mutation', { tabId: 7, ref: 'ref_1' }],
  ['browser_select', 'select', 'mutation', { tabId: 7, ref: 'ref_1', value: 'choice' }],
  ['browser_drag', 'drag', 'mutation', { tabId: 7, fromRef: 'ref_1', toRef: 'ref_2' }],
  ['browser_wait', 'wait', 'safe', { tabId: 7, condition: 'network_idle', timeoutMs: 5_000 }],
  [
    'browser_click_point',
    'click_point',
    'mutation',
    { tabId: 7, x: 120.5, y: 300, button: 'right', count: 2 },
  ],
  [
    'browser_drag_point',
    'drag_point',
    'mutation',
    { tabId: 7, fromX: 10, fromY: 20, toX: 300, toY: 400 },
  ],
  ['browser_network_start', 'network_start', 'mutation', { tabId: 7 }],
  [
    'browser_network_list',
    'network_list',
    'safe',
    { tabId: 7, urlPattern: '/api/', limit: 50, mode: 'endpoint_sample' },
  ],
  [
    'browser_network_get',
    'network_get',
    'safe',
    {
      tabId: 7,
      requests: [
        {
          requestId: 'request_1',
          includeRequestBody: true,
          includeResponseBody: false,
        },
        {
          requestId: 'request_2',
          includeRequestBody: false,
          includeResponseBody: true,
        },
      ],
    },
  ],
  ['browser_network_stop', 'network_stop', 'mutation', { tabId: 7 }],
] as const;

const NAMES = CASES.map(([name]) => name);

describe('BROWSER_TOOL_DEFINITIONS', () => {
  it('exposes the exact ordered set of small browser tools', () => {
    expect(BROWSER_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual(NAMES);
  });

  it('uses flat strict schemas with every property required', () => {
    for (const definition of BROWSER_TOOL_DEFINITIONS) {
      expect(definition.strict).toBe(true);
      expect(definition.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      const parameters = definition.parameters as {
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required: readonly string[];
      };
      expect(parameters.required).toEqual(Object.keys(parameters.properties));
      expect(Object.values(parameters.properties)).not.toContainEqual(
        expect.objectContaining({ type: 'object' }),
      );
    }
  });

  it('omits function-schema keywords rejected by the model API', () => {
    const serialized = JSON.stringify(BROWSER_TOOL_DEFINITIONS);
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'uniqueItems']) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
  });

  it('advertises a bounded strict batch selection array without uniqueItems', () => {
    const definition = BROWSER_TOOL_DEFINITIONS.find(
      ({ name }) => name === 'browser_set_checked_many',
    );
    const parameters = definition?.parameters as {
      readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    };

    expect(parameters.properties.items).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', minLength: 1, maxLength: 128 },
          checked: { type: 'boolean' },
        },
        required: ['ref', 'checked'],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(parameters.properties.items)).not.toContain('uniqueItems');
  });

  it('advertises bounded per-request body choices for batch network reads', () => {
    const definition = BROWSER_TOOL_DEFINITIONS.find(({ name }) => name === 'browser_network_get');
    const parameters = definition?.parameters as {
      readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    };

    expect(parameters.properties.requests).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          requestId: { type: 'string', minLength: 1, maxLength: 512 },
          includeRequestBody: { type: 'boolean' },
          includeResponseBody: { type: 'boolean' },
        },
        required: ['requestId', 'includeRequestBody', 'includeResponseBody'],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(parameters.properties.requests)).not.toContain('uniqueItems');
  });

  it('advertises bounded and explicit deep native interactive modes', () => {
    const inspect = BROWSER_TOOL_DEFINITIONS.find(
      (definition) => definition.name === 'browser_inspect',
    );
    const parameters = inspect?.parameters as
      | {
          readonly properties: Readonly<Record<string, unknown>>;
        }
      | undefined;
    const mode = parameters?.properties.mode as {
      readonly enum?: readonly string[];
    };

    expect(mode.enum).toEqual(['content', 'interactive', 'interactive_deep', 'screenshot']);
  });

  it('documents AX-first inspection and idempotent selectable actions', () => {
    const definitions = new Map(
      BROWSER_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
    );

    expect(definitions.get('browser_inspect')?.description).toContain('Always inspect interactive');
    expect(definitions.get('browser_inspect')?.description).toContain(
      'Do not use screenshots to verify semantic form state',
    );
    expect(definitions.get('browser_inspect')?.description).toContain(
      'browser_click_point becomes available on the next model turn',
    );
    expect(definitions.get('browser_click')?.description).toContain('advertises set_checked');
    expect(definitions.get('browser_inspect')?.description).toContain(
      'scrollable ref that advertises scroll',
    );
    expect(definitions.get('browser_inspect')?.description).toContain(
      'page-global coverage.complete=false does not by itself make a named-section objective incomplete',
    );
    expect(definitions.get('browser_inspect')?.description).toContain(
      'inspect the destination heading and requested content, then answer without traversing unrelated content below it',
    );
    expect(definitions.get('browser_inspect')?.description).toContain(
      'Treat a terse named-section command such as Chinese “看下/看看/打开/定位/跳到/选择 + 章节名” as locate/view only',
    );
    expect(definitions.get('browser_inspect')?.description).not.toContain(
      'When interactive coverage.complete=false, the returned tree is not complete page evidence and the relevant coverage target must be traversed before answering.',
    );
    expect(definitions.get('browser_inspect')?.description).toContain(
      'do not click same-page navigation or table-of-contents links before or after traversal',
    );
    expect(definitions.get('browser_scroll')?.description).toContain(
      'Do not click passive content to reveal more items',
    );
    expect(definitions.get('browser_scroll')?.description).toContain(
      'One call may consume the distance in multiple virtualized segments',
    );
    expect(definitions.get('browser_scroll')?.description).toContain(
      'observations is the chronological sequence',
    );
    expect(definitions.get('browser_scroll')?.description).toContain(
      'instead of immediately inspecting it again',
    );
    expect(definitions.get('browser_scroll')?.description).toContain('virtualized content changed');
    expect(definitions.get('browser_scroll')?.description).toContain('loadedMore=true');
    expect(definitions.get('browser_scroll')?.description).toContain('needsBoundaryProbe=true');
    expect(definitions.get('browser_scroll')?.description).toContain('boundaryVerified=true');
    expect(definitions.get('browser_scroll')?.description).toContain('requestedDeltaApplied=false');
    expect(definitions.get('browser_scroll')?.description).toContain('remainingDelta');
    expect(definitions.get('browser_scroll')?.description).toContain(
      'outside the requested interval',
    );
    expect(definitions.get('browser_scroll_until')?.description).toContain(
      'Only when the user explicitly requests reading, analyzing, or summarizing an entire named section, stop at the next same-level or higher-level heading',
    );
    expect(definitions.get('browser_scroll_until')?.description).toContain(
      'Do not use an empty stopText merely to continue to the document boundary for a named section',
    );
    expect(definitions.get('browser_scroll_until')?.description).toContain(
      'do not click anchors, headings, or table-of-contents items before or after traversal',
    );
    expect(definitions.get('browser_scroll_until')?.description).toContain(
      'For whole-document reading or page-summary objectives, regardless of the current viewport, first traverse upward with negative deltaY until the upper boundary is verified; only then traverse downward from that boundary',
    );
    expect(definitions.get('browser_scroll_until')?.description).toContain(
      'Treat a terse request to look at, open, locate, or jump to a named section as locate/view, not complete-section reading',
    );
    expect(definitions.get('browser_scroll_until')?.description).not.toContain(
      'For a complete named-section reading or summary',
    );
    expect(definitions.get('browser_select')?.description).toContain('advertises select');
    expect(definitions.get('browser_select')?.description).toContain('custom dropdown');
  });

  it('requires an explicit string base snapshot on model-generated inspections', () => {
    const inspect = BROWSER_TOOL_DEFINITIONS.find(
      (definition) => definition.name === 'browser_inspect',
    );
    const parameters = inspect?.parameters as {
      readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      readonly required: readonly string[];
    };

    expect(parameters.properties.since).toMatchObject({
      type: 'string',
      maxLength: 64,
    });
    expect(parameters.required).toContain('since');
  });

  it('requires a zero-capable tabId on every task-scoped model tool', () => {
    const definitions = new Map(
      BROWSER_TOOL_DEFINITIONS.map((definition) => [definition.name, definition.parameters]),
    );
    for (const name of [
      'browser_navigate',
      'browser_reload',
      'browser_inspect',
      'browser_capture_screenshot',
      'browser_paste_image',
      'browser_click',
      'browser_set_checked',
      'browser_set_checked_many',
      'browser_type',
      'browser_keypress',
      'browser_scroll',
      'browser_scroll_until',
      'browser_hover',
      'browser_select',
      'browser_drag',
      'browser_wait',
      'browser_click_point',
      'browser_drag_point',
      'browser_network_start',
      'browser_network_list',
      'browser_network_get',
      'browser_network_stop',
    ]) {
      const parameters = definitions.get(name) as {
        readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
        readonly required: readonly string[];
      };
      expect(parameters.properties.tabId).toMatchObject({
        type: 'integer',
        minimum: 0,
      });
      expect(parameters.required).toContain('tabId');
    }
    for (const name of ['browser_switch_tab', 'browser_close_tab']) {
      const parameters = definitions.get(name) as {
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required: readonly string[];
      };
      expect(parameters.properties).toHaveProperty('tabId');
      expect(parameters.required).toContain('tabId');
    }
  });
});

describe('parseBrowserToolCall', () => {
  it.each([
    ['browser_navigate', { url: 'https://example.com/a' }],
    ['browser_reload', {}],
    ['browser_inspect', { mode: 'interactive' }],
    ['browser_capture_screenshot', {}],
    ['browser_paste_image', { ref: 'ref_1', assetId: 'attachment_1' }],
    ['browser_click', { ref: 'ref_1', button: 'left', count: 1 }],
    ['browser_set_checked', { ref: 'ref_1', checked: true }],
    ['browser_set_checked_many', { items: [{ ref: 'ref_1', checked: true }] }],
    ['browser_type', { ref: 'ref_1', text: 'hello', replace: true, submit: false }],
    ['browser_network_list', { urlPattern: '/api/', limit: 25, mode: 'recent' }],
  ])('accepts task-bound %s without a model-provided tabId', (name, arguments_) => {
    expect(
      parseBrowserToolCall({
        callId: 'call_bound',
        name,
        argumentsJson: JSON.stringify(arguments_),
      }),
    ).toMatchObject({ name, arguments: arguments_ });
  });

  it('accepts explicit deep interactive inspection without adding another tool', () => {
    expect(
      parseBrowserToolCall({
        callId: 'call_deep',
        name: 'browser_inspect',
        argumentsJson: JSON.stringify({ tabId: 7, mode: 'interactive_deep' }),
      }),
    ).toMatchObject({
      operation: 'inspect',
      arguments: { tabId: 7, mode: 'interactive_deep' },
    });
  });

  it('accepts zero as the task-current tab sentinel', () => {
    expect(
      parseBrowserToolCall({
        callId: 'call_current',
        name: 'browser_inspect',
        argumentsJson: JSON.stringify({ tabId: 0, mode: 'content' }),
      }),
    ).toMatchObject({
      operation: 'inspect',
      arguments: { tabId: 0, mode: 'content' },
    });
  });

  it.each(CASES)(
    'parses %s into one typed browser operation',
    (name, operation, replay, arguments_) => {
      const argumentsJson = JSON.stringify(arguments_);

      expect(parseBrowserToolCall({ callId: 'call_1', name, argumentsJson })).toEqual({
        family: 'browser',
        operation,
        replay,
        callId: 'call_1',
        name,
        argumentsJson,
        arguments: arguments_,
      });
    },
  );

  it.each(CASES)('rejects extra parameters for %s', (name, _operation, _replay, arguments_) => {
    expect(() =>
      parseBrowserToolCall({
        callId: 'call_1',
        name,
        argumentsJson: JSON.stringify({ ...arguments_, unexpected: true }),
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it.each([
    ['browser_open_tab', { url: 'chrome://settings', activate: true }],
    ['browser_navigate', { tabId: 7, url: 'https://user:pass@example.com' }],
    ['browser_click', { tabId: 7, ref: 'x'.repeat(129), button: 'left', count: 1 }],
    [
      'browser_type',
      {
        tabId: 7,
        ref: 'ref_1',
        text: 'x'.repeat(20_001),
        replace: true,
        submit: false,
      },
    ],
    ['browser_keypress', { tabId: 7, keys: 'x'.repeat(101) }],
    ['browser_scroll', { tabId: 7, target: 'viewport', deltaX: 0, deltaY: 0 }],
    ['browser_scroll', { tabId: 7, target: 'viewport', deltaX: 0, deltaY: 10_001 }],
    [
      'browser_scroll_until',
      {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: 0,
        maxSegments: 16,
        stopText: '',
      },
    ],
    [
      'browser_scroll_until',
      {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: 1_201,
        maxSegments: 8,
        stopText: '',
      },
    ],
    [
      'browser_scroll_until',
      {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: -1_000,
        maxSegments: 25,
        stopText: '',
      },
    ],
    [
      'browser_scroll_until',
      {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: -1_000,
        maxSegments: 8,
        stopText: 'x'.repeat(501),
      },
    ],
    ['browser_wait', { tabId: 7, condition: 'delay', timeoutMs: 249 }],
    ['browser_click_point', { tabId: 7, x: -1, y: 1, button: 'left', count: 1 }],
    ['browser_network_list', { tabId: 7, urlPattern: '', limit: 101, mode: 'recent' }],
    ['browser_network_get', { tabId: 7, requests: [] }],
    [
      'browser_network_get',
      {
        tabId: 7,
        requests: Array.from({ length: 6 }, (_, index) => ({
          requestId: `request_${String(index)}`,
          includeRequestBody: false,
          includeResponseBody: false,
        })),
      },
    ],
    [
      'browser_network_get',
      {
        tabId: 7,
        requests: [
          {
            requestId: ' request_1',
            includeRequestBody: false,
            includeResponseBody: false,
          },
        ],
      },
    ],
    ['browser_set_checked_many', { tabId: 7, items: [] }],
    [
      'browser_set_checked_many',
      {
        tabId: 7,
        items: Array.from({ length: 21 }, (_, index) => ({
          ref: `ref_${String(index)}`,
          checked: true,
        })),
      },
    ],
    [
      'browser_set_checked_many',
      {
        tabId: 7,
        items: [
          { ref: 'ref_1', checked: true },
          { ref: 'ref_1', checked: false },
        ],
      },
    ],
    [
      'browser_set_checked_many',
      { tabId: 7, items: [{ ref: 'ref_1', checked: true, unexpected: true }] },
    ],
  ])('rejects bounded input for %s without exposing its contents', (name, arguments_) => {
    let thrown: unknown;
    try {
      parseBrowserToolCall({
        callId: 'call_1',
        name,
        argumentsJson: JSON.stringify(arguments_),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(thrown)).not.toContain('chrome://settings');
  });

  it.each([
    { callId: '', name: 'browser_list_tabs', argumentsJson: '{}' },
    { callId: 'c'.repeat(257), name: 'browser_list_tabs', argumentsJson: '{}' },
    { callId: 'call_1', name: 'browser_eval', argumentsJson: '{}' },
    {
      callId: 'call_1',
      name: 'browser_list_tabs',
      argumentsJson: '{secret-value',
    },
    {
      callId: 'call_1',
      name: 'browser_list_tabs',
      argumentsJson: `${' '.repeat(32 * 1_024)}{}`,
    },
  ])('redacts malformed browser call envelopes', (input) => {
    let thrown: unknown;
    try {
      parseBrowserToolCall(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(thrown)).not.toContain('secret-value');
  });
});
