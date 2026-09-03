export type ModelInputPreparationStage =
  'settings' | 'conversation_history' | 'tool_contract' | 'agent_context' | 'assistant_message';

const modelInputPreparationStages = new Set<ModelInputPreparationStage>([
  'settings',
  'conversation_history',
  'tool_contract',
  'agent_context',
  'assistant_message',
]);

/** Preserves a safe preparation stage while keeping the underlying error out of durable UI state. */
export class ModelInputPreparationError extends Error {
  readonly stage: ModelInputPreparationStage;

  constructor(stage: ModelInputPreparationStage, cause: unknown) {
    super(`Model input preparation failed at ${stage}.`, { cause });
    this.name = 'ModelInputPreparationError';
    this.stage = stage;
  }
}

export function isModelInputPreparationError(error: unknown): error is ModelInputPreparationError {
  if (error instanceof ModelInputPreparationError) return true;
  if (!(error instanceof Error) || error.name !== 'ModelInputPreparationError') return false;
  const stage = Reflect.get(error, 'stage');
  return (
    typeof stage === 'string' &&
    modelInputPreparationStages.has(stage as ModelInputPreparationStage)
  );
}

/** Adds one stable stage to pre-request failures without converting user cancellation into failure. */
export async function prepareModelInput<T>(
  stage: ModelInputPreparationStage,
  operation: Promise<T>,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (
      isModelInputPreparationError(error) ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    throw new ModelInputPreparationError(stage, error);
  }
}
