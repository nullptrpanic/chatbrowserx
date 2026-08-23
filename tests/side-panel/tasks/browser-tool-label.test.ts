import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import { toolDisplayName } from '../../../src/side-panel/tasks/browser-tool-label';

describe('browser tool labels', () => {
  it('localizes bounded scrolling in every interface language', () => {
    expect(toolDisplayName('browser_scroll_until', createTranslator('zh-CN'))).toBe('连续滚动页面');
    expect(toolDisplayName('browser_scroll_until', createTranslator('en'))).toBe(
      'Scroll until condition',
    );
    expect(toolDisplayName('browser_scroll_until', createTranslator('ja'))).toBe(
      '条件までスクロール',
    );
  });

  it('localizes Sandbox read and command tools', () => {
    expect(toolDisplayName('sandbox_read', createTranslator('zh-CN'))).toBe('读取沙箱文件');
    expect(toolDisplayName('sandbox_exec', createTranslator('zh-CN'))).toBe('执行沙箱命令');
    expect(toolDisplayName('sandbox_read', createTranslator('en'))).toBe('Read sandbox file');
    expect(toolDisplayName('sandbox_exec', createTranslator('en'))).toBe('Run sandbox command');
  });
});
