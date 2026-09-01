import { register } from '../register';
import type { ToolRuntimeHooks } from '../types';
import { BROWSER_TOOL_SPECS } from './contract';
import { browserTool } from './declaration';
import { browserPreflight } from './lifecycle';
import { browserService } from './service';

export const browserRuntime = {
  preflight(call, context) {
    return browserPreflight(call, context);
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

for (const [order, spec] of BROWSER_TOOL_SPECS.entries()) {
  register(browserTool(spec, order), browserRuntime);
}
