import type { TranslationRect } from './translation-regions';

export interface TranslationTextSource {
  key: Node;
  owner: Element;
  nodes: Text[];
  text: string;
  plain: string;
  markers: Element[];
  lines: TranslationRect[];
  whitespace?:
    | {
        before: string;
        after: string;
        slots?: { marker: number; before: string; after: string }[];
      }
    | undefined;
}

export const translationTypography = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textDecoration',
  'color',
  'direction',
] as const;
