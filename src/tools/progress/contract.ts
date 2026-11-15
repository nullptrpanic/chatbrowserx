import { z } from 'zod';
import { strictFunctionTool, strictObjectSchema } from '../model-tool';

export const TASK_PROGRESS_TOOL = 'task.progress';
const LEGACY_TASK_PROGRESS_TOOL = 'task_progress';
export function isProgressTool(name: string): boolean {
  return name === TASK_PROGRESS_TOOL || name === LEGACY_TASK_PROGRESS_TOOL;
}

const stepId = z.string().trim().min(1).max(200);
const stepText = z.string().trim().min(1).max(400);
const evidenceCallId = z.string().trim().max(200);
const reason = z.string().trim().max(600);
const scope = z.string().trim().min(1).max(1000);
const longText = z.string().trim().max(1000);
const statuses = ['pending', 'in_progress', 'completed', 'uncertain', 'excluded'] as const;

const planStep = z
  .object({
    id: stepId,
    step: stepText,
    status: z.enum(statuses),
    evidenceCallId: evidenceCallId.nullable(),
    reason: reason.nullable(),
  })
  .strict();

const progressStateSchema = z
  .object({
    plan: z.array(planStep).max(100),
    explanation: longText.nullable(),
    inventory: z.object({ scope, complete: z.boolean(), evidence: longText }).strict(),
    blocker: longText.nullable(),
  })
  .strict();
export const progressSchema = z.object({ update: progressStateSchema.nullable() }).strict();
export type ProgressState = z.infer<typeof progressStateSchema>;
export type ProgressInput = z.infer<typeof progressSchema>;

const previousStep = z
  .object({
    id: stepId,
    description: stepText,
    status: z.enum(['pending', 'verified', 'excluded', 'uncertain']),
    evidence: reason,
    evidenceCallId,
  })
  .strict();
const previousState = z
  .object({
    scope,
    inventoryComplete: z.boolean(),
    inventoryEvidence: longText,
    blocker: longText,
    items: z.array(previousStep).max(100),
  })
  .strict()
  .transform((state): ProgressState => ({
    plan: state.items.map(({ id, description, status, evidenceCallId, evidence }) => ({
      id,
      step: description,
      status: status === 'verified' ? 'completed' : status,
      evidenceCallId: evidenceCallId || null,
      reason: evidence || null,
    })),
    explanation: null,
    inventory: {
      scope: state.scope,
      complete: state.inventoryComplete,
      evidence: state.inventoryEvidence,
    },
    blocker: state.blocker || null,
  }));

export const savedProgressStateSchema = z.union([progressStateSchema, previousState]);
export const savedProgressInputSchema = z
  .object({ update: savedProgressStateSchema.nullable() })
  .strict();
export const progressRecordedSchemas = new Map([
  [LEGACY_TASK_PROGRESS_TOOL, savedProgressInputSchema],
]);

export const progressDefinition = strictFunctionTool(
  TASK_PROGRESS_TOOL,
  [
    'Track a plan for tasks with multiple independent deliverables. Use stable step IDs across updates and read back uncertain outcomes before further writes.',
    'Record the authorized scope and observed inventory before mutations. Mark completed only with a usable observation call ID from availableEvidence. Follow review.next until completion is ready or an external blocker is recorded.',
  ].join(' '),
  {
    update: {
      description:
        'Use null to read the plan and evidence. Updates upsert steps by ID; omitted steps remain.',
      anyOf: [
        { type: 'null' },
        strictObjectSchema({
          plan: {
            type: 'array',
            maxItems: 100,
            items: strictObjectSchema({
              id: { type: 'string', minLength: 1, maxLength: 200 },
              step: { type: 'string', minLength: 1, maxLength: 400 },
              status: { type: 'string', enum: statuses },
              evidenceCallId: { type: ['string', 'null'], maxLength: 200 },
              reason: {
                type: ['string', 'null'],
                maxLength: 600,
                description: 'Explain uncertainties or exclusions.',
              },
            }),
          },
          explanation: { type: ['string', 'null'], maxLength: 1000 },
          inventory: strictObjectSchema({
            scope: { type: 'string', minLength: 1, maxLength: 1000 },
            complete: {
              type: 'boolean',
              description: 'True only after enumerating the full scope.',
            },
            evidence: {
              type: 'string',
              maxLength: 1000,
              description: 'How full coverage was verified.',
            },
          }),
          blocker: { type: ['string', 'null'], maxLength: 1000 },
        }),
      ],
    },
  },
);
