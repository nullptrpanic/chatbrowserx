import { describe, expect, it } from 'vitest';
import { BROWSER_EXECUTION_POLICY } from '../../../src/tools/browser/policy';

describe('browser execution policy', () => {
  it('keeps current-page evidence on the browser path', () => {
    expect(BROWSER_EXECUTION_POLICY).toContain(
      'Current-page evidence MUST come from Browser tools',
    );
  });
});
