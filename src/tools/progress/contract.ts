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
    'Track multi-item work; do not use for simple single-step requests.',
    'Record the authorized scope, observed items and exclusions before mutations. Update observed outcomes, in batches when useful; follow review.next for remaining work.',
    'For uncertain outcomes, read back before further writes; do not repeat an uncertain mutation. Partial or virtualized results cannot prove absence: inspect or scroll the relevant scope.',
    'Pending/uncertain items or incomplete inventory prevent completion. Finish only when review.completion is ready; actual blockers pause, and user stop/runtime limits take priority.',
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
