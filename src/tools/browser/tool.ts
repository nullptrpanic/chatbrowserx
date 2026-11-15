import { register } from '../register';
import type { ToolRuntimeHooks, ValidatedToolCall } from '../types';
import { BROWSER_PUBLIC_TOOLS, browserEngineCall, type BrowserCommand } from './public-contract';
import { browserTool } from './declaration';
import { browserPreflight } from './lifecycle';
import { browserService } from './service';

export const browserRuntime = {
  preflight(call, context) {
    return browserPreflight(browserEngineCall(call as ValidatedToolCall<BrowserCommand>), context);
  },
  contextCompacted(services) {
    if (services.has(browserService)) {
      services.get(browserService).resetObservationBaselines();
    }
  },
  async release(ownerId, services) {
    if (services.has(browserService)) {
      await services.get(browserService).release(ownerId);
    }
  },
} satisfies ToolRuntimeHooks;

for (const [order, spec] of BROWSER_PUBLIC_TOOLS.entries()) {
  register(browserTool(spec, order), browserRuntime);
}
