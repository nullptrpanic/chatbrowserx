const MAX_TEXT_CHARACTERS = 40_000;
const MAX_HEADINGS = 100;
const MAX_LINKS = 100;
const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);

export interface ReadableHeading {
  readonly level: number;
  readonly text: string;
}

export interface ReadableLink {
  readonly text: string;
  readonly url: string;
}

export interface ReadablePageContent {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly headings: readonly ReadableHeading[];
  readonly links: readonly ReadableLink[];
  readonly truncated: boolean;
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function isHidden(element: Element): boolean {
  if (
    element.hasAttribute('hidden') ||
    element.hasAttribute('inert') ||
    element.getAttribute('aria-hidden') === 'true' ||
    element.closest('[data-chatbrowserx-overlay]') !== null
  ) {
    return true;
  }
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) return false;
  const style = ownerWindow.getComputedStyle(element);
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.contentVisibility === 'hidden'
  );
}

function visitDocumentRoots(document_: Document, visit: (node: Node) => void): void {
  if (document_.body) visit(document_.body);
}

/** Extracts bounded visible page text, headings, and important links without page scripts. */
export function extractReadableContent(document_: Document, _window: Window): ReadablePageContent {
  void _window;
  const textParts: string[] = [];
  const headings: ReadableHeading[] = [];
  const links: ReadableLink[] = [];
  const seenLinks = new Set<string>();
  let structureTruncated = false;

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizedText(node.textContent);
      if (text.length > 0) textParts.push(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (EXCLUDED_TAGS.has(element.tagName) || isHidden(element)) return;

    if (/^H[1-6]$/.test(element.tagName)) {
      const text = normalizedText(element.textContent);
      if (text.length > 0) {
        if (headings.length < MAX_HEADINGS) {
          headings.push({ level: Number(element.tagName[1]), text: text.slice(0, 500) });
        } else {
          structureTruncated = true;
        }
      }
    }
    if (element.tagName === 'A' && element.getAttribute('href')) {
      try {
        const url = new URL(element.getAttribute('href') ?? '', element.ownerDocument.baseURI);
        const text = normalizedText(element.textContent).slice(0, 500);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && !seenLinks.has(url.href)) {
          seenLinks.add(url.href);
          if (links.length < MAX_LINKS) links.push({ text, url: url.href.slice(0, 4_096) });
          else structureTruncated = true;
        }
      } catch {
        // Invalid page-owned links are ignored.
      }
    }

    for (const child of element.childNodes) visit(child);
    if (element.shadowRoot) for (const child of element.shadowRoot.childNodes) visit(child);
    if (element.tagName === 'IFRAME') {
      try {
        const frame = element as HTMLIFrameElement;
        if (frame.contentDocument) visitDocumentRoots(frame.contentDocument, visit);
      } catch {
        // Cross-origin frames are added from their CDP accessibility session.
      }
    }
  };
  visitDocumentRoots(document_, visit);
  const fullText = normalizedText(textParts.join(' '));
  return {
    title: normalizedText(document_.title).slice(0, 500),
    url: document_.location.href.slice(0, 4_096),
    text: fullText.slice(0, MAX_TEXT_CHARACTERS),
    headings,
    links,
    truncated: structureTruncated || fullText.length > MAX_TEXT_CHARACTERS,
  };
}
