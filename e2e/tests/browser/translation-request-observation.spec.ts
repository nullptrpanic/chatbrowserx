import { once } from 'node:events';
import { createServer } from 'node:http';
import { extensionTest, expect } from './fixtures/extension-test';
import {
  observeTranslationRequest,
  type TranslationRequestState,
} from '../../diagnostics/translation-request';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'diagnostic observes cancellation after successful streaming headers',
  async ({ extensionSession }) => {
    const server = createServer((request, response) => {
      if (request.url === '/stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: pending\n\n');
      } else {
        response.end('<!doctype html><title>Stream cancellation fixture</title>');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const page = await extensionSession.context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      const requestSeen = page.waitForRequest((request) => request.url().endsWith('/stream'));
      const headersSeen = page.evaluate(async () => {
        const controller = new AbortController();
        const response = await fetch('/stream', { signal: controller.signal });
        void response.text().catch(() => undefined);
        addEventListener('cancel-stream', () => controller.abort(), {
          once: true,
        });
        return response.status;
      });
      const request = await requestSeen;
      const failed = page.waitForEvent('requestfailed', {
        predicate: (r) => r === request,
      });
      const record: TranslationRequestState = {};
      const observation = observeTranslationRequest(
        request.response(),
        record,
        failed.then(() => {
          throw new Error('Observed fixture cancellation');
        }),
      );
      expect(await headersSeen).toBe(200);
      await expect.poll(() => record.status).toBe(200);
      expect(record.finished).toBeUndefined();
      await page.evaluate(() => dispatchEvent(new Event('cancel-stream')));
      await observation;
      expect(request.failure()?.errorText).toBe('net::ERR_ABORTED');
      expect(record).toEqual({
        status: 200,
        transportFailed: true,
        finished: true,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
