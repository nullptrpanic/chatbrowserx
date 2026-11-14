import { createServer } from 'node:http';
import { ResponsesTraceCollector } from '../../runner/provider-trace';
import { extensionTest, expect } from './fixtures/extension-test';

extensionTest.use({ extensionHeadless: true });

for (const completed of [true, false]) {
  extensionTest(
    `captures a cancelled SSE stream with completed=${String(completed)}`,
    async ({ extensionSession }) => {
      const terminalType = completed ? 'response.completed' : 'response.output_text.delta';
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"type":"response.created"}\n\n');
        const timer = setTimeout(() => {
          response.write(
            `data: ${JSON.stringify({
              type: terminalType,
              delta: 'private-response-text',
              response: { output: [] },
            })}\n\n`,
          );
        }, 150);
        response.on('close', () => clearTimeout(timer));
        // Deliberately keep HTTP open after the model's terminal event, as a live SSE service can.
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Fixture server is unavailable.');
      const url = `http://127.0.0.1:${String(address.port)}/responses`;
      const collector = new ResponsesTraceCollector(
        extensionSession.context,
        extensionSession.extensionId,
        url,
      );
      try {
        await collector.start('synthetic question');
        await extensionSession.serviceWorker.evaluate(
          async ({ url, terminalType }) => {
            const controller = new AbortController();
            const response = await fetch(url, {
              method: 'POST',
              body: JSON.stringify({ input: [], stream: true }),
              signal: controller.signal,
            });
            if (!response.body) throw new Error('Synthetic SSE has no response stream.');
            const reader = response.body.getReader();
            let text = '';
            while (!text.includes(terminalType)) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error('Synthetic SSE ended prematurely.');
              text += new TextDecoder().decode(chunk.value);
            }
            controller.abort();
          },
          { url, terminalType },
        );
        const trace = await collector.finish();
        expect(trace.requestCount).toBe(1);
        expect(trace.requests[0]?.response).toMatchObject({
          status: 200,
          completed,
          failed: false,
          captureError: null,
        });
        expect(trace.requests[0]?.response.eventTypes).toContain(terminalType);
        expect(JSON.stringify(trace)).not.toContain('private-response-text');
      } finally {
        await collector.finish();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}
