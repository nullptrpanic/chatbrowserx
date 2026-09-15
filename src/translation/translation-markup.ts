/** Only locally assigned, flat style identities are interpreted. Never parse model HTML. */
export function escapeTranslationText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function translationSegments(text: string): { id?: string; text: string }[] {
  const segments: { id?: string; text: string }[] = [];
  const seen = new Set<string>();
  let offset = 0,
    current: string | undefined;
  const append = (value: string) => {
    if (value)
      segments.push({
        ...(current === undefined ? {} : { id: current }),
        text: value.replace(/&(lt|gt|amp);/g, (_, name: string) =>
          name === 'lt' ? '<' : name === 'gt' ? '>' : '&',
        ),
      });
  };
  for (const match of text.matchAll(/<(\/?)m(\d+)>/g)) {
    append(text.slice(offset, match.index));
    const id = match[2];
    if (id === undefined) throw new Error('Invalid translation marker.');
    if (match[1]) {
      if (current !== id) throw new Error('Invalid translation marker.');
      current = undefined;
    } else {
      if (current !== undefined || seen.has(id)) throw new Error('Invalid translation marker.');
      seen.add(id);
      current = id;
    }
    offset = match.index + match[0].length;
  }
  if (current !== undefined) throw new Error('Unclosed translation marker.');
  append(text.slice(offset));
  return segments;
}

export function validateTranslationMarkup(source: string, output: string): void {
  const identities = (text: string) =>
    translationSegments(text)
      .flatMap((s) => (s.id === undefined ? [] : [s.id]))
      .sort();
  if (JSON.stringify(identities(source)) !== JSON.stringify(identities(output)))
    throw new Error('Translation style identities changed.');
}
