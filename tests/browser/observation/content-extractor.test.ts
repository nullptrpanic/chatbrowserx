import { beforeEach, describe, expect, it } from 'vitest';
import { extractReadableContent } from '../../../src/browser/observation/content-extractor';

beforeEach(() => {
  document.head.innerHTML = '<title>Example page</title>';
  document.body.innerHTML = '';
});

describe('extractReadableContent', () => {
  it('normalizes visible text, headings, links, shadow DOM, and same-origin frames', () => {
    document.body.innerHTML = `
      <h1>  Checkout   details </h1>
      <p>First\n paragraph</p>
      <a href="/help"> Help center </a>
      <div hidden>hidden secret</div>
      <div data-chatbrowserx-overlay="virtual-pointer">extension overlay</div>
      <iframe></iframe>
    `;
    const shadowHost = document.createElement('section');
    shadowHost.attachShadow({ mode: 'open' }).innerHTML =
      '<h2>Shadow heading</h2><p>Shadow text</p>';
    document.body.append(shadowHost);
    const frame = document.querySelector('iframe');
    if (!frame?.contentDocument) throw new Error('Frame fixture is unavailable.');
    frame.contentDocument.body.innerHTML = '<h2>Frame heading</h2><p>Frame text</p>';

    const result = extractReadableContent(document, window);

    expect(result).toMatchObject({
      title: 'Example page',
      headings: [
        { level: 1, text: 'Checkout details' },
        { level: 2, text: 'Frame heading' },
        { level: 2, text: 'Shadow heading' },
      ],
      links: [{ text: 'Help center', url: 'http://localhost:3000/help' }],
      truncated: false,
    });
    expect(result.text).toContain('First paragraph');
    expect(result.text).toContain('Frame text');
    expect(result.text).toContain('Shadow text');
    expect(result.text).not.toMatch(/hidden secret|extension overlay/);
  });

  it('hard-bounds readable text and reports truncation', () => {
    document.body.textContent = 'x'.repeat(45_000);

    const result = extractReadableContent(document, window);

    expect(result.text).toHaveLength(40_000);
    expect(result.truncated).toBe(true);
  });
});
