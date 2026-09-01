import { register } from '../register';
import type { ToolRuntimeHooks } from '../types';
import { BROWSER_TOOL_DEFINITIONS, type BrowserToolName } from './contract';
import { browserTool } from './declaration';
import { browserPreflight } from './lifecycle';
import { BROWSER_EXECUTION_POLICY } from './policy';
import { browserService } from './service';

export const browserRuntime = {
  instructions: [BROWSER_EXECUTION_POLICY],
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

for (const { name } of BROWSER_TOOL_DEFINITIONS) {
  register(browserTool(name as BrowserToolName), browserRuntime);
}
