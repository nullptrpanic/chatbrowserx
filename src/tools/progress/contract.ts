import { z } from 'zod';
import { strictFunctionTool } from '../model-tool';

export const TASK_PROGRESS_TOOL = 'task_progress';

const itemSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(400),
    status: z.enum(['pending', 'verified', 'excluded', 'uncertain']),
    evidence: z.string().trim().max(600),
    evidenceCallId: z.string().trim().max(200),
  })
  .strict();

export const progressStateSchema = z
  .object({
    scope: z.string().trim().min(1).max(1000),
    inventoryComplete: z.boolean(),
    inventoryEvidence: z.string().trim().max(1000),
    blocker: z.string().trim().max(1000),
    items: z.array(itemSchema).max(100),
  })
  .strict();

export const progressSchema = z.object({ update: progressStateSchema.nullable() }).strict();
export type ProgressState = z.infer<typeof progressStateSchema>;
export type ProgressInput = z.infer<typeof progressSchema>;

export const progressDefinition = strictFunctionTool(
  TASK_PROGRESS_TOOL,
  [
    'Optional ledger for multiple independent deliverables or actions across a collection. Do not use for a single deliverable, even if it takes several tool calls; execution steps are not separate deliverables.',
    'Only after choosing to track such a task: record its authorized scope, observed items and exclusions before mutations; update outcomes in batches and follow review.next until review.completion is ready.',
    'In a tracked task, read back uncertain outcomes before further writes. Partial or virtualized lists cannot establish complete inventory. Actual blockers pause; user stop/runtime limits take priority.',
  ].join('\n'),
  {
    update: {
      description:
        'null reads the durable ledger and availableEvidence, including after compaction/resume. An object replaces scope metadata and upserts items; omitted items remain.',
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['scope', 'inventoryComplete', 'inventoryEvidence', 'blocker', 'items'],
          properties: {
            scope: {
              type: 'string',
              minLength: 1,
              maxLength: 1000,
              description:
                'The complete user-authorized scope and exclusions, not one visible page.',
            },
            inventoryComplete: {
              type: 'boolean',
              description: 'true only when the full scope has been enumerated.',
            },
            inventoryEvidence: {
              type: 'string',
              maxLength: 1000,
              description:
                'How full coverage was established; required when inventoryComplete is true.',
            },
            blocker: {
              type: 'string',
              maxLength: 1000,
              description: 'An actual external condition preventing further work; otherwise empty.',
            },
            items: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'description', 'status', 'evidence', 'evidenceCallId'],
                properties: {
                  id: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 200,
                    description: 'Stable observed identity reused across updates.',
                  },
                  description: { type: 'string', minLength: 1, maxLength: 400 },
                  status: {
                    type: 'string',
                    enum: ['pending', 'verified', 'excluded', 'uncertain'],
                    description:
                      'pending: not done; uncertain: outcome unconfirmed; verified: postcondition observed, not merely dispatched; excluded: outside authorized scope.',
                  },
                  evidence: {
                    type: 'string',
                    maxLength: 600,
                    description:
                      'Observed outcome, uncertainty or exclusion reason; required unless pending.',
                  },
                  evidenceCallId: {
                    type: 'string',
                    maxLength: 200,
                    description:
                      'For verified, copy the observation callId from availableEvidence, not a snapshot ID or tool name. Otherwise may be empty.',
                  },
                },
              },
            },
          },
        },
      ],
    },
  },
);
