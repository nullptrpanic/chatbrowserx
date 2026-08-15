import type { ObservedElementState, ShadowSegment } from '../contracts/observation';

const textInputTypes = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'password', 'number']);

/**
 * Collapses untrusted page whitespace and clamps semantic strings to a safe local length.
 */
export function normalizeText(value: string | null | undefined, limit = 500): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Returns an explicit or native implicit role for elements relevant to browser interaction.
 */
export function getElementRole(element: Element): string | null {
  const explicitRole = normalizeText(element.getAttribute('role'), 80);
  if (explicitRole.length > 0) {
    return explicitRole.split(' ')[0] ?? null;
  }

  const tagName = element.tagName.toLowerCase();
  if (tagName === 'button') return 'button';
  if (tagName === 'a' && element.hasAttribute('href')) return 'link';
  if (tagName === 'textarea') return 'textbox';
  if (tagName === 'select') return (element as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  if (tagName === 'option') return 'option';
  if (tagName === 'dialog') return 'dialog';
  if (tagName === 'summary') return 'button';
  if (tagName === 'input') {
    const input = element as HTMLInputElement;
    const type = input.type.toLowerCase();
    if (textInputTypes.has(type)) return 'textbox';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'range') return 'slider';
  }
  if (element.getAttribute('contenteditable') === 'true') return 'textbox';
  if (element.hasAttribute('tabindex')) return 'generic';
  return null;
}

/**
 * Reads the first normalized label associated through native HTML label semantics.
 */
export function getAssociatedLabel(element: Element): string | null {
  const labels =
    'labels' in element ? (element.labels as NodeListOf<HTMLLabelElement> | null) : null;
  const label = normalizeText(labels?.[0]?.textContent);
  return label.length > 0 ? label : null;
}

/**
 * Derives an accessible name in the approved deterministic precedence order.
 */
export function getAccessibleName(element: Element, label: string | null): string {
  const ariaLabel = normalizeText(element.getAttribute('aria-label'));
  if (ariaLabel.length > 0) return ariaLabel;
  if (label !== null) return label;

  const labelledBy = normalizeText(
    (element.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
  if (labelledBy.length > 0) return labelledBy;

  const role = getElementRole(element);
  if (role === 'button' || role === 'link' || role === 'option' || role === 'dialog') {
    const content = normalizeText(element.textContent);
    if (content.length > 0) return content;
  }
  const alt = normalizeText(element.getAttribute('alt'));
  if (alt.length > 0) return alt;
  const title = normalizeText(element.getAttribute('title'));
  if (title.length > 0) return title;
  const placeholder = normalizeText(element.getAttribute('placeholder'));
  if (placeholder.length > 0) return placeholder;
  if (element.tagName === 'INPUT') {
    const input = element as HTMLInputElement;
    if (['button', 'submit', 'reset'].includes(input.type)) return normalizeText(input.value);
  }
  return '';
}

/**
 * Rejects identifiers that look generated, hashed, framework-owned, or mostly numeric.
 */
function isStableIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 120) return false;
  if (/^:r\d+:$/i.test(value)) return false;
  if (/(?:react|mui|headlessui|radix|ember)[-_:]?\d/i.test(value)) return false;
  if (/[a-f0-9]{10,}/i.test(value) || /\d{6,}/.test(value)) return false;
  return true;
}

/**
 * Keeps only allowlisted semantic attributes that can survive a normal DOM rerender.
 */
export function getStableAttributes(element: Element): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  for (const name of ['data-testid', 'name', 'id', 'autocomplete', 'type']) {
    const value = normalizeText(element.getAttribute(name), 160);
    if (value.length === 0) continue;
    if (name === 'id' && !isStableIdentifier(value)) continue;
    attributes[name] = value;
  }
  return attributes;
}

/**
 * Reads live form state without serializing arbitrary element properties.
 */
export function getElementValue(element: Element): string | null {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) {
    return normalizeText(
      (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value,
      2_000,
    );
  }
  if (element.getAttribute('contenteditable') === 'true') {
    return normalizeText(element.textContent, 2_000);
  }
  return null;
}

/**
 * Normalizes the interaction states shared by DOM and CDP observations.
 */
export function getElementState(element: Element): ObservedElementState {
  const tagName = element.tagName;
  const disabled =
    ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(tagName) &&
    (
      element as
        | HTMLButtonElement
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
        | HTMLOptionElement
    ).disabled;
  const checked =
    tagName === 'INPUT' && ['checkbox', 'radio'].includes((element as HTMLInputElement).type)
      ? (element as HTMLInputElement).checked
      : null;
  const selected = tagName === 'OPTION' ? (element as HTMLOptionElement).selected : null;
  const expandedValue = element.getAttribute('aria-expanded');
  const expanded = expandedValue === null ? null : expandedValue === 'true';
  return { disabled, checked, selected, expanded };
}

/** Derives nearby form, dialog, region, or heading context for duplicate-target disambiguation. */
export function getAncestorHint(
  element: Element,
  contextCache?: WeakMap<Element, string | null>,
): string | null {
  let current = element.parentElement;
  let depth = 0;
  while (current !== null && depth < 8) {
    if (contextCache?.has(current) === true) {
      const cached = contextCache.get(current) ?? null;
      if (cached !== null) return cached;
      current = current.parentElement;
      depth += 1;
      continue;
    }

    let context: string | null = null;
    const role = getElementRole(current);
    if (['dialog', 'form', 'region', 'group'].includes(role ?? '')) {
      const name = getAccessibleName(current, getAssociatedLabel(current));
      if (name.length > 0) context = name;
    }
    if (context === null) {
      const heading = [...current.children].find((child) => /^H[1-6]$/.test(child.tagName));
      const headingText = normalizeText(heading?.textContent, 200);
      if (headingText.length > 0) context = headingText;
    }
    if (context === null && current.tagName === 'FORM') {
      const formName = normalizeText(
        current.getAttribute('aria-label') ?? current.getAttribute('name') ?? current.id,
        200,
      );
      if (formName.length > 0) context = formName;
    }
    contextCache?.set(current, context);
    if (context !== null) return context;
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * Describes an open Shadow Root host using the same durable semantic fields as a target.
 */
export function createShadowSegment(host: Element): ShadowSegment {
  const label = getAssociatedLabel(host);
  return {
    hostRole: getElementRole(host),
    hostName: getAccessibleName(host, label) || null,
    stableAttributes: getStableAttributes(host),
  };
}
