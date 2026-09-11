type Box = [number, number, number, number];
interface TranslationBlock {
  text: string;
  translation: string;
  box: Box;
}

export function parseTranslation(value: string): TranslationBlock[] {
  const { blocks } = JSON.parse(value.trim().replace(/^```json\s*|\s*```$/g, ''));
  if (
    !Array.isArray(blocks) ||
    blocks.some(
      ({ text, translation, box }) =>
        typeof text !== 'string' ||
        typeof translation !== 'string' ||
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every(Number.isFinite) ||
        box[0] < 0 ||
        box[1] < 0 ||
        box[2] <= 0 ||
        box[3] <= 0 ||
        box[0] + box[2] > 1000 ||
        box[1] + box[3] > 1000,
    )
  ) {
    throw new Error('Invalid translation blocks');
  }
  return blocks;
}

export function projectBox(
  [x, y, width, height]: Box,
  viewportWidth: number,
  viewportHeight: number,
) {
  return {
    left: (x * viewportWidth) / 1000,
    top: (y * viewportHeight) / 1000,
    width: (width * viewportWidth) / 1000,
    height: (height * viewportHeight) / 1000,
  };
}
