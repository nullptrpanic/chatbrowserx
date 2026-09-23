interface DiagnosticOperations {
  run(): Promise<void>;
  cleanup: readonly (readonly [string, () => Promise<void>])[];
  persist(failures: readonly { stage: string; name: string }[]): Promise<void>;
}

/** Native-feature diagnostics must retain evidence independently of visual capture. */
export async function runDiagnostic(operations: DiagnosticOperations): Promise<void> {
  const failures: { stage: string; name: string }[] = [];
  let first: unknown;
  const attempt = async (stage: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      if (!failures.length) first = error;
      // Error messages can contain page text or URLs. Persist only the operation and class.
      failures.push({
        stage,
        name: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  };
  await attempt('run', operations.run);
  for (const [stage, cleanup] of operations.cleanup) await attempt(stage, cleanup);
  await attempt('evidence', () => operations.persist(failures));
  if (failures.length) throw first;
}
