import { describe, expect, it } from 'vitest';
import { IMAGE_POLICY, validateImageBatch } from '../../src/attachments/attachment-policy';

/** Creates a named image file with an exact byte size for policy tests. */
function image(name: string, type: string, size = 32): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('validateImageBatch', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
    'accepts supported %s images',
    (type) => {
      const file = image('picture', type);

      expect(validateImageBatch([file])).toEqual({ ok: true, files: [file] });
    },
  );

  it.each(['image/svg+xml', 'text/html', 'text/plain'])('rejects unsafe %s input', (type) => {
    expect(validateImageBatch([image('unsafe', type)])).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_TYPE',
    });
  });

  it('enforces non-empty, per-image, count, and aggregate limits', () => {
    expect(validateImageBatch([image('empty.png', 'image/png', 0)])).toMatchObject({
      ok: false,
      code: 'EMPTY_IMAGE',
    });
    expect(
      validateImageBatch([image('large.png', 'image/png', IMAGE_POLICY.maxBytesPerImage + 1)]),
    ).toMatchObject({ ok: false, code: 'IMAGE_TOO_LARGE' });
    expect(
      validateImageBatch(
        Array.from({ length: IMAGE_POLICY.maxCount + 1 }, (_, index) =>
          image(`${String(index)}.png`, 'image/png'),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'TOO_MANY_IMAGES' });
    expect(
      validateImageBatch(
        Array.from({ length: 4 }, (_, index) =>
          image(`${String(index)}.png`, 'image/png', 8 * 1024 * 1024),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'BATCH_TOO_LARGE' });
  });

  it('includes existing draft usage when validating additions', () => {
    expect(
      validateImageBatch([image('next.png', 'image/png')], {
        count: IMAGE_POLICY.maxCount,
        bytes: 100,
      }),
    ).toMatchObject({ ok: false, code: 'TOO_MANY_IMAGES' });
  });
});
