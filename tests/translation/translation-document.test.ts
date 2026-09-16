import { expect, it } from 'vitest';
import { isTranslationDocument } from '../../src/page/translation/translation-document';

it.each([
  ['https://fixture.larkoffice.com/docx/readable', true],
  ['https://fixture.feishu.cn/docx/readable', true],
  ['https://fixture.larksuite.com/docx/readable', true],
  ['https://fixture.larkoffice.com/im', false],
  ['https://fixture.larkoffice.com.example.com/docx/readable', false],
  ['https://unrelated.test/docx/readable', false],
  ['http://fixture.larkoffice.com/docx/readable', false],
])('allows only recognized document prose at %s', (url, allowed) => {
  const doc = { location: new URL(url) } as unknown as Document;
  expect(isTranslationDocument(doc)).toBe(allowed);
});
