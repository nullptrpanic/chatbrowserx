import { expect, it } from 'vitest';
import { runDiagnostic } from '../../diagnostics/diagnostic-cleanup';

it('restores settings and persists evidence when cleanup screenshots fail, preserving the primary error', async () => {
  const calls: string[] = [];
  const original = new Error('Source layout did not settle');
  const failures: string[][] = [];
  await expect(
    runDiagnostic({
      run: async () => {
        throw original;
      },
      cleanup: [
        [
          'screenshot',
          async () => {
            calls.push('screenshot');
            throw new Error('Font timeout');
          },
        ],
        [
          'settings',
          async () => {
            calls.push('settings');
          },
        ],
      ],
      persist: async (errors) => {
        calls.push('evidence');
        failures.push(errors.map((e) => e.stage));
      },
    }),
  ).rejects.toBe(original);
  expect(calls).toEqual(['screenshot', 'settings', 'evidence']);
  expect(failures).toEqual([['run', 'screenshot']]);
});

it('reports cleanup failure instead of silently passing a successful diagnostic', async () => {
  const error = new Error('Restore failed');
  let persisted = false;
  await expect(
    runDiagnostic({
      run: async () => undefined,
      cleanup: [
        [
          'settings',
          async () => {
            throw error;
          },
        ],
      ],
      persist: async (failures) => {
        expect(failures).toEqual([{ stage: 'settings', name: 'Error' }]);
        persisted = true;
      },
    }),
  ).rejects.toBe(error);
  expect(persisted).toBe(true);
});
