import { z } from 'zod';

export const listEntrySchema = z
  .object({
    match: z.string().min(1).regex(/^[a-z0-9.-]+$/, 'lowercase hostname or domain only'),
    matchLevel: z.enum(['domain', 'host']),
    kind: z.enum(['farm', 'human']),
    siteBehavior: z.number().int().min(0).max(100),
    reasons: z.array(z.string().min(1)).min(1),
    source: z.enum(['seed', 'review']),
  })
  .strict();

export const selectorConfigSchema = z
  .object({
    version: z.number().int().positive(),
    result: z.string().min(1),
    title: z.string().min(1),
    exclude: z.array(z.string().min(1)),
    /** Present on every results page; if it matches but no result does, the layout drifted. Default '#rso'. */
    page: z.string().min(1).optional(),
  })
  .strict();

export const listBundleSchema = z
  .object({ version: z.string().min(1), domains: z.array(listEntrySchema), selectors: selectorConfigSchema })
  .strict();

export const flagReasonSchema = z.enum(['filler', 'ai_images', 'fake_reviews', 'untested_roundup', 'other']);

export const flagBodySchema = z
  .object({ url: z.string().url().max(2048), verdict: z.enum(['slop', 'fine']), reason: flagReasonSchema.optional() })
  .strict()
  .refine((b) => (b.verdict === 'slop' ? b.reason !== undefined : b.reason === undefined), {
    message: 'reason is required for slop flags and not allowed for fine flags',
  });

export const scoreBodySchema = z.object({ urls: z.array(z.string().min(1).max(2048)).min(1).max(20) }).strict();

export const eventBodySchema = z
  .object({ configVersion: z.number().int().positive(), event: z.literal('no_matches') })
  .strict();

export const deviceBodySchema = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
