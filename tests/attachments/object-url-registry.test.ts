import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectUrlRegistry } from '../../src/attachments/object-url-registry';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ObjectUrlRegistry', () => {
  it('reuses URLs and revokes each only after the final release', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const registry = new ObjectUrlRegistry();
    const blob = new Blob(['image'], { type: 'image/png' });

    expect(registry.acquire('attachment_1', blob)).toBe('blob:preview');
    expect(registry.acquire('attachment_1', blob)).toBe('blob:preview');
    registry.release('attachment_1');
    expect(revoke).not.toHaveBeenCalled();
    registry.release('attachment_1');

    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:preview');
  });

  it('releases every remaining URL exactly once', () => {
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const registry = new ObjectUrlRegistry();

    registry.acquire('first', new Blob(['1']));
    registry.acquire('second', new Blob(['2']));
    registry.releaseAll();
    registry.releaseAll();

    expect(revoke.mock.calls.flat()).toEqual(['blob:first', 'blob:second']);
  });
});
