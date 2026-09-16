import type { TranslationRect } from './translation-regions';

/** Docx uses contenteditable for the document itself, not just for unsubmitted drafts. */
export function isTranslationDocument(doc: Document): boolean {
  const url = doc.location;
  return (
    !!url &&
    url.protocol === 'https:' &&
    /(^|\.)(larkoffice\.com|feishu\.cn|larksuite\.com)$/.test(url.hostname) &&
    url.pathname.startsWith('/docx/')
  );
}

export function isTranslationDocumentText(element: Element): boolean {
  if (!isTranslationDocument(element.ownerDocument)) return false;
  const editor = element.closest('.zone-container.text-editor');
  if (!editor?.closest('.page-block.root-block')) return false;
  // A nested draft/input is not document prose even when it lives inside an editor zone.
  for (
    let current: Element | null = element;
    current && current !== editor;
    current = current.parentElement
  ) {
    if (
      current.matches(
        'input,textarea,select,form,[role="textbox"],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]',
      )
    )
      return false;
  }
  return editor.getAttribute('contenteditable') !== 'plaintext-only';
}

/** Editor cursor placeholders have no visible text or style identity to translate. */
export function isTranslationDocumentPlaceholder(element: Element): boolean {
  return (
    element.matches('span[data-enter="true"][data-string="true"]') &&
    /^[\u200b\ufeff]+$/.test(element.textContent ?? '') &&
    isTranslationDocumentText(element)
  );
}

const backgroundProperties = [
  'backgroundImage',
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundOrigin',
  'backgroundClip',
] as const;

export interface TranslationWatermark {
  box: TranslationRect;
  style: Pick<CSSStyleDeclaration, (typeof backgroundProperties)[number]>;
}

/** Only the known, static Docx watermark can be reproduced over a source-text mask. */
export function translationDocumentWatermark(
  el: Element,
  view: Window,
): TranslationWatermark | null {
  if (
    // The hydrated client replaces .ssrWaterMark with these stable suite classes.
    !el.matches('div.ssrWaterMark,div.suite-clear,div.suite-hidden') ||
    !isTranslationDocument(el.ownerDocument) ||
    el.childElementCount ||
    el.textContent?.trim()
  )
    return null;
  const s = view.getComputedStyle(el);
  if (
    s.position !== 'fixed' ||
    s.pointerEvents !== 'none' ||
    s.opacity !== '1' ||
    s.transform !== 'none' ||
    s.filter !== 'none' ||
    s.mixBlendMode !== 'normal' ||
    s.backgroundImage === 'none' ||
    (el.getAnimations?.().length ?? 0) > 0 ||
    !['transparent', 'rgba(0, 0, 0, 0)'].includes(s.backgroundColor) ||
    [
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
    ].some((p) => parseFloat(s[p as keyof CSSStyleDeclaration] as string))
  )
    return null;
  const r = el.getBoundingClientRect();
  return {
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
    style: Object.fromEntries(
      backgroundProperties.map((p) => [p, s[p]]),
    ) as TranslationWatermark['style'],
  };
}
