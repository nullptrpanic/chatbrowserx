import type { Checkpoint } from './checkpoint-types';

/** Returns the stable attachment owner references retained by durable tool results. */
export function checkpointResultReferences(
  checkpoints: readonly Checkpoint[],
): ReadonlySet<string> {
  return new Set(
    checkpoints.flatMap((checkpoint) =>
      Array.isArray(checkpoint.completedToolResults)
        ? checkpoint.completedToolResults.flatMap((result) =>
            typeof result.resultRef === 'string' && result.resultRef.length > 0
              ? [result.resultRef]
              : [],
          )
        : [],
    ),
  );
}
