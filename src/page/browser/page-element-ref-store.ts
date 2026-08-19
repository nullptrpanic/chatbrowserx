/** Keeps one latest-snapshot map of opaque page element refs inside the isolated content script. */
export class PageElementRefStore {
  readonly #elements = new Map<string, Element>();
  #generation = 0;

  replace(elements: readonly Element[]): readonly string[] {
    this.#elements.clear();
    this.#generation += 1;
    return elements.map((element, index) => {
      const ref = `page_${String(this.#generation)}_${String(index + 1)}`;
      this.#elements.set(ref, element);
      return ref;
    });
  }

  resolve(ref: string): Element | undefined {
    return this.#elements.get(ref);
  }
}

const stores = new WeakMap<Document, PageElementRefStore>();

/** Returns the isolated ref store owned by one page document. */
export function pageElementRefStore(document_: Document): PageElementRefStore {
  const existing = stores.get(document_);
  if (existing) return existing;
  const created = new PageElementRefStore();
  stores.set(document_, created);
  return created;
}
