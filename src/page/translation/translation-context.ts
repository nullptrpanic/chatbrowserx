import { MAX_TRANSLATION_CONTEXT_CHARS } from '../../translation/region-translation';

const excluded =
  'script,style,noscript,template,nav,footer,form,input,textarea,select,[contenteditable],svg,canvas,video,iframe,' +
  '[hidden],[inert],[aria-hidden="true"],[role="navigation"],[role="menu"],[role="menubar"],[data-chatbrowserx-overlay]';
const headings = 'h1,h2,h3,h4,h5,h6';
const blocks = `p,li,dt,dd,td,th,pre,blockquote,figcaption,${headings}`;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
type Passage = { owner: Element; text: string };

/** Request-local, DOM-anchored context. Never scans body.innerText or changes the page/cache. */
export function collectTranslationContext(doc: Document, sources: readonly Node[]): string {
  const view = doc.defaultView;
  if (!doc.body || !view) return '';
  const styles = new Map<Element, CSSStyleDeclaration>();
  const visibility = new Map<Element, boolean>();
  const style = (el: Element) => {
    let value = styles.get(el);
    if (!value) styles.set(el, (value = view.getComputedStyle(el)));
    return value;
  };
  const visible = (el: Element, depth = 0): boolean => {
    const cached = visibility.get(el);
    if (cached !== undefined) return cached;
    const s = style(el);
    const parent = el.parentElement;
    const result =
      depth < 64 &&
      !el.matches(excluded) &&
      s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      s.visibility !== 'collapse' &&
      s.opacity !== '0' &&
      s.contentVisibility !== 'hidden' &&
      (!s.clipPath || s.clipPath === 'none') &&
      (!s.clip || s.clip === 'auto') &&
      (!parent ||
        (visible(parent, depth + 1) &&
          (!parent.matches('details:not([open])') || el.matches('summary'))));
    visibility.set(el, result);
    return result;
  };
  const ownerOf = (node: Node): Element | null => {
    let el = node.parentElement;
    for (let depth = 0; depth < 64 && el?.parentElement; depth++) {
      if (
        el.matches(blocks) ||
        !['', 'inline', 'inline-block', 'contents'].includes(style(el).display)
      )
        break;
      el = el.parentElement;
    }
    return el;
  };
  const anchors = [
    ...new Set(
      sources
        .filter((source) => {
          const el =
            source.nodeType === Node.ELEMENT_NODE ? (source as Element) : source.parentElement;
          return source.isConnected && source.ownerDocument === doc && el && visible(el);
        })
        .map((source) => {
          if (source.nodeType !== Node.TEXT_NODE) return source;
          const owner = ownerOf(source);
          return owner === null || owner === doc.body ? source : owner;
        }),
    ),
  ].slice(0, 32);
  if (!anchors.length) return '';

  // Bound visits including empty/hidden nodes, not just accepted text. Each direction has
  // its own allowance so a large preceding subtree cannot starve the following caption.
  const visitLimit = Math.min(256, Math.floor(2048 / (anchors.length * 3)));
  function scan(anchor: Node, direction: 'before' | 'after' | 'current', charLimit: number) {
    const reverse = direction === 'before';
    const sibling = reverse ? 'previousSibling' : 'nextSibling';
    const child = reverse ? 'lastChild' : 'firstChild';
    const paragraphs = new Map<Element, Passage>();
    let visits = 0,
      characters = 0;
    const done = () => visits >= visitLimit || characters >= charLimit;
    function visit(node: Node, depth = 0) {
      if (done()) return;
      visits++;
      if (depth >= 64) return;
      if (node.nodeType === Node.ELEMENT_NODE && !visible(node as Element)) return;
      if (node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR') {
        if (node.parentElement?.matches('details:not([open])')) return;
        const raw = node.nodeName === 'BR' ? '\n' : (node as Text).data;
        const remaining = charLimit - characters;
        const text = (reverse ? raw.slice(-remaining) : raw.slice(0, remaining)).replace(
          /\s+/g,
          ' ',
        );
        const owner = ownerOf(node);
        if (!owner) return;
        let passage = paragraphs.get(owner);
        if (!normalize(text) && !passage) return;
        if (!passage) {
          passage = { owner, text: '' };
          paragraphs.set(owner, passage);
          if (paragraphs.size > 1) characters++;
        }
        passage.text = reverse ? text + passage.text : passage.text + text;
        characters += text.length;
        return;
      }
      for (let n = node[child]; n && !done(); n = n[sibling]) visit(n, depth + 1);
    }
    if (direction === 'current') visit(anchor);
    else {
      const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
      const boundary = el?.closest('article,main,[role="main"]') ?? doc.body;
      for (
        let branch: Node | null = anchor;
        branch && branch !== boundary && !done();
        branch = branch.parentNode
      ) {
        visits++;
        for (let n = branch[sibling]; n && !done(); n = n[sibling]) visit(n);
      }
    }
    return [...paragraphs.values()]
      .map((p) => ({ ...p, text: normalize(p.text) }))
      .filter((p) => p.text);
  }

  const seen = new Set<string>();
  const title = normalize(doc.title.slice(0, 200));
  const prefix = title ? `Page title: ${title}\n\n` : '';
  const perGroup = Math.floor((MAX_TRANSLATION_CONTEXT_CHARS - prefix.length) / anchors.length) - 2;
  function take(passages: Passage[], budget: number, reverse: boolean) {
    const parts: string[] = [];
    for (const { text } of passages) {
      if (seen.has(text)) continue;
      const room = budget - (parts.length ? 1 : 0);
      if (room <= 0) break;
      const part =
        reverse && text.length > room
          ? `…${room > 1 ? text.slice(1 - room) : ''}`
          : clip(text, room);
      parts.push(part);
      seen.add(text);
      budget -= part.length + (parts.length > 1 ? 1 : 0);
    }
    return (reverse ? parts.reverse() : parts).join('\n');
  }
  const groups = anchors.map((anchor, index) => {
    let result = `[Target ${index + 1}]`;
    // The full translation target is already in the request. Keep its identification compact
    // so nearby prose, including captions, receives most of the shared character budget.
    const currentLimit = Math.min(200, Math.floor(perGroup / 4));
    const image = anchor.nodeType === Node.ELEMENT_NODE && (anchor as Element).matches('img');
    const current = image
      ? normalize((anchor as HTMLImageElement).alt.slice(0, currentLimit))
      : scan(anchor, 'current', currentLimit)
          .map((p) => p.text)
          .join('\n');
    if (current && !seen.has(current)) {
      result += `\n${image ? 'Image description' : 'Current text'}: ${current}`;
      seen.add(current);
    }
    const room = Math.max(0, perGroup - result.length - 17); // Before/after labels.
    const before = scan(anchor, 'before', room).filter((p) => !seen.has(p.text));
    const after = scan(anchor, 'after', room).filter((p) => !seen.has(p.text));
    const beforeLength = before.map((p) => p.text).join('\n').length;
    const afterLength = after.map((p) => p.text).join('\n').length;
    // Split evenly, then lend either side's unused allowance to the other.
    const beforeBudget = Math.min(beforeLength, room - Math.min(afterLength, Math.floor(room / 2)));
    const afterBudget = Math.min(afterLength, room - beforeBudget);
    const preceding = take(before, beforeBudget, true);
    const following = take(after, afterBudget, false);
    if (preceding) result += `\nBefore:\n${preceding}`;
    if (following) result += `\nAfter:\n${following}`;
    return result;
  });
  return (prefix + groups.join('\n\n')).slice(0, MAX_TRANSLATION_CONTEXT_CHARS);
}
