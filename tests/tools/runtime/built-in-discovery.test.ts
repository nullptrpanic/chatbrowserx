import { describe, expect, it } from 'vitest';
import { discoverToolDeclarations } from '../../../src/tools/discover';

describe('built-in tool discovery', () => {
  it('discovers registered tools in stable order', async () => {
    const declarations = await discoverToolDeclarations();

    expect(declarations.map(({ name }) => name)).toEqual([
      'task.progress',
      'browser.tab',
      'browser.navigate',
      'browser.reload',
      'browser.inspect',
      'browser.screenshot',
      'browser.paste',
      'browser.click',
      'browser.set_checked',
      'browser.type',
      'browser.keypress',
      'browser.scroll',
      'browser.hover',
      'browser.select',
      'browser.drag',
      'browser.wait',
      'network.capture',
      'network.list',
      'network.get',
      'sandbox.read',
      'sandbox.exec',
      'history.search',
      'history.read',
      'attachment.read',
    ]);
    for (const { name, definition } of declarations) {
      expect(definition.name).toBe(name);
      expect(definition.strict).toBe(true);
    }
  });
});
