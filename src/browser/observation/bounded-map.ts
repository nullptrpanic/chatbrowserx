/** Maps independent work with deterministic output order and a fixed concurrency ceiling. */
export async function mapConcurrentOrdered<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  worker: (value: TInput, index: number) => Promise<TOutput>,
): Promise<readonly TOutput[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a positive integer.');
  }
  if (values.length === 0) return [];
  const results: (TOutput | undefined)[] = new Array(values.length);
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await worker(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results as TOutput[];
}
