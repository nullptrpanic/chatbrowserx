import { createServer, type Server } from 'node:http';
import { verifyConfiguredLiveEnvironment } from '../../runner/live-environment';
import { createPlaywrightLiveRuntime } from '../../runner/run-live-scenario';
import type { LiveScenario } from '../../runner/live-types';
import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';
import { closeHttpFixtureServer } from './helpers/http-server';

function syntheticAccessToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_environment_rebuild',
    },
  })}.`;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Fixture server unavailable.');
  return address.port;
}

extensionTest(
  'verifies a reconstructed profile, extension tab access, origin, and target readiness',
  async ({ extensionSession }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><main><h1>Evaluation Workspace</h1><p>Ready to run</p></main>');
    });
    try {
      const port = await listen(server);
      const origin = `http://127.0.0.1:${String(port)}`;
      const scenario: LiveScenario = {
        contractVersion: 1,
        name: 'environment-rebuild-smoke',
        description: 'Verifies the complete reconstructed environment boundary.',
        exclusiveResources: [],
        startUrl: `${origin}/workspace`,
        expectedOrigin: origin,
        taskText: 'Do not submit this fixture task.',
        readinessTimeoutMs: 10_000,
        environment: {
          targetSetupMode: 'none',
          targetSetupInstructions: [],
          readinessChecks: [
            { kind: 'url_includes', value: '/workspace' },
            { kind: 'page_text_includes', value: 'Evaluation Workspace' },
            { kind: 'page_text_any', values: ['Ready to run', 'Prepared'] },
          ],
        },
        taskTimeoutMs: 10_000,
        maxToolCalls: 1,
        requiredTools: [],
        forbiddenTools: [],
        forbidScreenshotInspect: true,
        forbidSubmittedType: true,
        finalTextIncludes: [],
        minFinalTextLength: 0,
        allowRemoteMutation: false,
      };
      await sendExtensionMessage(extensionSession.sidePanelPage, {
        version: 1,
        requestId: 'environment_rebuild_settings',
        type: 'settings.save',
        payload: {
          reasoningEffort: 'low',
          systemPrompt: 'Use available browser tools.',
          language: 'en',
          historyMessageLimit: 50,
          codexAccessToken: syntheticAccessToken(),
        },
      });
      const runtime = createPlaywrightLiveRuntime(extensionSession);
      const target = await runtime.openTarget(scenario);

      const verification = await verifyConfiguredLiveEnvironment(
        runtime,
        scenario,
        target,
        'environment_rebuild_verify',
      );

      expect(verification.passed).toBe(true);
      expect(verification.checks.every(({ passed }) => passed)).toBe(true);
    } finally {
      await closeHttpFixtureServer(server);
    }
  },
);
