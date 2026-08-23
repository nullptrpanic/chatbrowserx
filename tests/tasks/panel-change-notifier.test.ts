import { describe, expect, it, vi } from 'vitest';
import { PanelChangeNotifier } from '../../src/tasks/panel-change-notifier';

describe('PanelChangeNotifier', () => {
  it('advances monotonically and coalesces synchronous publications', async () => {
    const publish = vi.fn(async () => undefined);
    const notifier = new PanelChangeNotifier({
      clock: { now: () => 1_000 },
      publish,
    });

    notifier.changed();
    notifier.changed();
    await Promise.resolve();

    expect(notifier.getVersion()).toBe(1_001);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({
      version: 1,
      type: 'panel.stateChanged',
      stateVersion: 1_001,
    });
  });
});
