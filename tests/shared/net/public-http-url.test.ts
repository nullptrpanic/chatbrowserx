import { describe, expect, it } from 'vitest';
import { isPublicHttpUrl } from '../../../src/shared/net/public-http-url';

describe('isPublicHttpUrl', () => {
  it.each([
    ['https://example.com/docs', true],
    ['http://news.example.com/a', true],
    ['https://1.1.1.1/', true],
    ['https://[2606:4700:4700::1111]/', true],
    ['file:///etc/passwd', false],
    ['https://user:pass@example.com', false],
    ['http://localhost:3000', false],
    ['http://api.localhost/', false],
    ['http://intranet/', false],
    ['http://printer.local/', false],
    ['http://127.0.0.1', false],
    ['http://127.1', false],
    ['http://0.0.0.0', false],
    ['http://10.0.0.1', false],
    ['http://172.16.0.1', false],
    ['http://192.168.1.2', false],
    ['http://169.254.1.1', false],
    ['http://224.0.0.1', false],
    ['http://[::1]/', false],
    ['http://[::]/', false],
    ['http://[fc00::1]/', false],
    ['http://[fe80::1]/', false],
    ['http://[ff02::1]/', false],
    ['not a url', false],
  ] as const)('classifies %s', (value, expected) => {
    expect(isPublicHttpUrl(value)).toBe(expected);
  });
});
