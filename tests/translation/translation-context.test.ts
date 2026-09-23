import { afterEach, expect, it, vi } from 'vitest';
import { collectTranslationContext } from '../../src/page/translation/translation-context';

function context(...selectors: string[]) {
  return collectTranslationContext(
    document,
    selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      if (!element.firstChild) throw new Error(`Empty ${selector}`);
      return element.firstChild;
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  document.title = '';
  vi.restoreAllMocks();
});

it('keeps mounted prose outside the viewport as context without including hidden UI or drafts', () => {
  document.body.innerHTML = `<article><p id="target">Target.</p><p id="after">Nearby definition below the viewport.</p>
    <nav>secret-menu</nav><p contenteditable>secret-draft</p><p style="clip-path:inset(50%)">secret-clip</p></article>`;
  const after = document.querySelector('#after');
  if (!after) throw new Error('Missing following paragraph');
  vi.spyOn(after, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 4000, 500, 40));
  const result = context('#target');
  expect(result).toContain('Nearby definition below the viewport.');
  expect(result).not.toContain('secret-');
});

it('uses read-only document context while excluding editable ancestors and nested drafts', () => {
  document.body.innerHTML = `<article contenteditable="true"><p>secret-before</p>
    <section contenteditable="false"><p>PB means benign boundary.</p>
    <p id="target">Translate this.</p><p contenteditable="invalid">FH means factual healing.</p>
    <p contenteditable="plaintext-only">secret-draft</p></section><p>secret-after</p></article>`;
  const result = context('#target');
  expect(result).toContain('PB means benign boundary.');
  expect(result).toContain('FH means factual healing.');
  expect(result).not.toContain('secret-');
});

it('locates repeated text by its DOM node and stays within the requested article', () => {
  document.title = 'Boundary-aware safety';
  document.body.innerHTML = `<nav>Unrelated navigation</nav><article>
    <section><h2>Wrong section</h2><p>PB is a file size.</p><p>Result</p></section></article><article>
    <section><h2>Boundary experiments</h2><p>PB means benign boundary data.</p>
      <div><div><p id="target">Result</p></div></div><p>FH means factual healing.</p></section>
  </article>`;
  const result = context('#target');
  for (const text of [
    'Boundary-aware safety',
    'Boundary experiments',
    'PB means benign boundary data.',
    'FH means factual healing.',
  ]) {
    expect(result).toContain(text);
  }
  expect(result).not.toContain('Wrong section');
  expect(result).not.toContain('file size');
  expect(result).not.toContain('Unrelated navigation');
});

it('reads figcaptions and nearby prose around a DOM text anchor', () => {
  document.body.innerHTML = `<article><h2>Refusal boundary</h2><p>Before the diagram.</p>
    <figure><div><a><p id="image">Target.</p></a></div>
      <figcaption>Pol denotes political prompts, not polynomials.</figcaption></figure>
    <p>Compl denotes compliance.</p></article>`;
  const result = context('#image');
  for (const text of [
    'Refusal boundary',
    'Before the diagram.',
    'Pol denotes political prompts',
    'Compl denotes compliance.',
  ]) {
    expect(result).toContain(text);
  }
});

it('keeps nearby plain paragraphs on both sides of a nested text target', () => {
  document.body.innerHTML =
    '<main><div><p>Before.</p></div><div><p><a><p id="image">Target.</p></a></p></div><div><p><em>Plain caption after.</em></p></div></main>';
  const result = context('#image');
  expect(result).toContain('Before.');
  expect(result).toContain('Plain caption after.');
});

it('excludes hidden menus, editable values and overlay text but keeps inline article text', () => {
  document.body.innerHTML = `<main><p>Visible <a>linked</a> prose.
      <span style="display:none">secret-inline</span><span contenteditable>secret-edit</span></p>
    <div style="opacity:0"><p>secret-opacity</p></div>
    <div style="clip-path:inset(50%)"><p>secret-clip</p></div>
    <nav>secret-nav</nav><div role="menu">secret-menu</div><form>secret-form</form>
    <details>secret-direct-disclosure<p>secret-disclosure</p></details><p hidden>secret-hidden</p>
    <div data-chatbrowserx-overlay="translation">secret-overlay</div>
    <p id="target">Read this.</p><p>Visible after.</p></main>`;
  const result = context('#target');
  expect(result).toContain('Visible linked prose.');
  expect(result).toContain('Visible after.');
  expect(result).not.toContain('secret-');
});

it('shares the fixed character budget across multiple targets and preserves nearby captions', () => {
  document.body.innerHTML = `<main>${[1, 2]
    .map(
      (id) => `<section>
    <p>${'Distant long prose. '.repeat(500)}</p>
    <figure><p id="image${id}">Target.</p><figcaption>Caption ${id} defines PB.</figcaption></figure>
    <p>Local explanation ${id}. ${'Additional detail. '.repeat(500)}</p>
  </section>`,
    )
    .join('')}</main>`;
  const result = context('#image1', '#image2');
  expect(result.length).toBeLessThanOrEqual(6000);
  for (const text of [
    'Caption 1 defines PB.',
    'Caption 2 defines PB.',
    'Local explanation 1.',
    'Local explanation 2.',
  ]) {
    expect(result).toContain(text);
  }
});

it('deduplicates shared context without losing the second requested neighborhood', () => {
  document.body.innerHTML =
    '<main><p>Shared definition.</p><p id="a">First target.</p><p id="b">Second target.</p><p>After second target.</p></main>';
  const result = context('#a', '#b', '#a');
  expect(result.split('Shared definition.')).toHaveLength(2);
  expect(result).toContain('After second target.');
});

it('does not walk a whole long page looking for a heading and reads current nearby content', () => {
  document.body.innerHTML = `<main><h1>Distant heading</h1>${'<i></i>'.repeat(5000)}<p>Local definition.</p><p id="target">Target.</p><p>After.</p></main>`;
  const style = vi.spyOn(window, 'getComputedStyle');
  const result = context('#target');
  expect(result).toContain('Local definition.');
  expect(result).not.toContain('Distant heading');
  expect(style.mock.calls.length).toBeLessThan(2000);
  const following = document.querySelector('#target')?.nextElementSibling;
  if (!following) throw new Error('Missing following paragraph');
  following.textContent = 'Updated nearby context.';
  expect(context('#target')).toContain('Updated nearby context.');
});

it('returns no context for disconnected or hidden request anchors', () => {
  document.body.innerHTML = '<p hidden id="hidden">Invisible.</p>';
  expect(context('#hidden')).toBe('');
  expect(collectTranslationContext(document, [document.createElement('p')])).toBe('');
});

it('keeps inline text within the nearest heading after two preceding paragraphs', () => {
  document.body.innerHTML =
    '<article><h2>Boundary <a>aware</a> safety</h2><p>Definition.</p><p>Result details.</p><p id="target">Target.</p></article>';
  expect(context('#target')).toContain('Boundary aware safety');
});

it('preserves spaces and line breaks between inline terms in nearby context', () => {
  document.body.innerHTML =
    '<article><p><a>PB</a> <em>means</em><br>benign boundary.</p><p id="target">Target.</p><p>FH<br>means <b>factual</b> <i>healing</i>.</p></article>';
  const result = context('#target');
  expect(result).toContain('PB means benign boundary.');
  expect(result).toContain('FH means factual healing.');
});

it('uses a character window across paragraphs and adjacent sections, not two blocks per side', () => {
  document.body.innerHTML = `<article><section><p>Earlier definition of PB.</p>
    <p>Before 3.</p><p>Before 2.</p><p>Before 1.</p></section>
    <section><p id="image">Target.</p><p>After 1.</p><p>After 2.</p><p>After 3.</p></section>
    <section><p>Later explanation of FH.</p></section></article>`;
  const result = context('#image');
  for (const text of [
    'Earlier definition of PB.',
    'Before 3.',
    'After 3.',
    'Later explanation of FH.',
  ])
    expect(result).toContain(text);
  expect(result.indexOf('Earlier definition')).toBeLessThan(result.indexOf('Before 1.'));
  expect(result.indexOf('After 1.')).toBeLessThan(result.indexOf('Later explanation'));
});

it('keeps approximately 3000 characters nearest each side rather than capping a passage at 1200', () => {
  document.body.innerHTML = `<article><p>Far before.${'B'.repeat(5000)}</p>
    <p id="image">Target.</p><p>${'A'.repeat(5000)}Far after.</p></article>`;
  const result = context('#image');
  expect(result.length).toBeLessThanOrEqual(6000);
  expect(result.length).toBeGreaterThan(5900);
  expect(result.match(/B/g)?.length).toBeGreaterThan(2900);
  expect(result.match(/A/g)?.length).toBeGreaterThan(2900);
  expect(result).not.toContain('Far before.');
  expect(result).not.toContain('Far after.');
});

it.each(['before', 'after'])('lets the %s side borrow unused character budget', (side) => {
  const prose = `<p>${'Context sentence. '.repeat(500)}</p>`;
  document.body.innerHTML = `<article>${side === 'before' ? prose : ''}<p id="image">Target.</p>${side === 'after' ? prose : ''}</article>`;
  const result = context('#image');
  expect(result.length).toBeGreaterThan(5900);
  expect(result.length).toBeLessThanOrEqual(6000);
});
