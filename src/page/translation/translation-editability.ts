import { isTranslationDocumentText } from './translation-document';

/** Exclude editable drafts, except known Docx document text and explicit read-only islands. */
export function translationEditable(element: Element | null): boolean {
  if (element && isTranslationDocumentText(element)) return false;
  for (let current = element; current; current = current.parentElement) {
    const value = current.getAttribute('contenteditable')?.toLowerCase();
    if (value === 'false') return false;
    if (value === '' || value === 'true' || value === 'plaintext-only') return true;
  }
  return element?.ownerDocument.designMode === 'on';
}
