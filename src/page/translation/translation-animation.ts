const appearanceProperty = (property: string) =>
  /^(color|background-color|border(?:-(?:top|right|bottom|left))?-color|outline-color|text-decoration-color|box-shadow)$/.test(
    property,
  );

export type TranslationStyleChange = 'none' | 'appearance' | 'layout' | 'motion';

export function classifyTranslationStyleChange(
  before: CSSStyleDeclaration,
  after: CSSStyleDeclaration,
): TranslationStyleChange {
  const changed = [...new Set([...Array.from(before), ...Array.from(after)])].filter(
    (name) =>
      before.getPropertyValue(name) !== after.getPropertyValue(name) ||
      before.getPropertyPriority(name) !== after.getPropertyPriority(name),
  );
  if (!changed.length) return 'none';
  if (changed.some((name) => /^(left|right|top|bottom|transform|translate)$/.test(name)))
    return 'motion';
  return changed.every(appearanceProperty) ? 'appearance' : 'layout';
}

/** Tiny, text-free CSS decorations can be frozen in the read-only mirror. Live
 * media, controls, animated text and large animation surfaces remain boundaries. */
export function hasLiveTranslationAnimation(el: Element): boolean {
  const live = el.getAnimations?.().some((animation) => {
    if (animation.playState !== 'running' && !animation.pending) return false;
    // Colors and box shadows decorate stationary text without changing its layout.
    // Both transitions and keyframes can implement stationary hover/TOC highlights.
    // Inspect every animated property: an additional transform/opacity animation
    // must still be treated as live, even when it also changes a color.
    const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null;
    const frames = effect?.getKeyframes() ?? [];
    const properties = [...new Set(frames.flatMap(Object.keys))].filter(
      (key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key),
    );
    return (
      properties.length === 0 ||
      properties.some((property) => {
        const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        if (appearanceProperty(cssProperty)) return false;
        // Chromium can emit transition-all events on zoom even when the declared
        // border width is unchanged. Compare the whole effect, not just its name.
        if (
          typeof CSSTransition !== 'undefined' &&
          animation instanceof CSSTransition &&
          frames.length > 1 &&
          frames.every(
            (frame) => Object.hasOwn(frame, property) && frame[property] === frames[0]?.[property],
          )
        )
          return false;
        // Zoom also quantizes default outline/rule widths with style:none. These
        // have no painted or layout effect. A real visible-width animation, or
        // any additional transform/opacity/style animation, remains live.
        if (
          /^(border-(top|right|bottom|left)|outline|(column|row)-rule)-width$/.test(cssProperty)
        ) {
          const style = el.ownerDocument.defaultView?.getComputedStyle(el, effect?.pseudoElement);
          if (
            /^(none|hidden)$/.test(
              style?.getPropertyValue(cssProperty.replace(/width$/, 'style')) ?? '',
            )
          )
            return false;
        }
        return true;
      })
    );
  });
  if (!live) return false;
  const box = el.getBoundingClientRect();
  return (
    /[\p{L}\p{N}]/u.test(el.textContent ?? '') ||
    box.width > 48 ||
    box.height > 48 ||
    el.matches('canvas,video,iframe,object,embed,input,textarea,select') ||
    el.querySelector('canvas,video,iframe,object,embed,input,textarea,select') !== null ||
    el.shadowRoot !== null
  );
}

/** A clipped text track stays independent even between animations. Empty editor
 * handles are not tracks and must not split ordinary tables/paragraphs. */
export function isTranslationTextTrack(el: Element, view: Window): boolean {
  const style = view.getComputedStyle(el);
  if (
    style.position === 'static' ||
    !/^(hidden|clip)$/.test(style.overflowX) ||
    !/^(hidden|clip)$/.test(style.overflowY) ||
    !/[\p{L}\p{N}]/u.test(el.textContent ?? '') ||
    [...el.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? ''),
    )
  )
    return false;
  const children = [...el.children].filter(
    (child) => view.getComputedStyle(child).display !== 'none',
  );
  return (
    children.length > 0 &&
    children.every((child) => view.getComputedStyle(child).position === 'absolute')
  );
}

export function translationMotionRoot(el: Element, view: Window): Element {
  for (
    let parent = el.parentElement;
    parent && parent !== el.ownerDocument.body;
    parent = parent.parentElement
  )
    if (isTranslationTextTrack(parent, view)) return parent;
  return el;
}
