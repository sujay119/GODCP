import { z } from 'zod';

export const differenceTypeSchema = z.enum([
  'camera',
  'placement',
  'scale',
  'missing_object',
  'extra_object',
  'color',
  'lighting',
  'composition',
  'perspective',
  'terrain',
  'proportions',
  'material',
  'other',
]);

export type DifferenceType = z.infer<typeof differenceTypeSchema>;

export const differenceSchema = z.object({
  type: differenceTypeSchema,
  object: z.string().optional(),
  description: z.string(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  confidence: z.number().min(0).max(1),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
});

export type Difference = z.infer<typeof differenceSchema>;

export const correctionActionSchema = z.enum([
  'move',
  'rotate',
  'scale',
  'add_object',
  'remove_object',
  'recolor',
  'relight',
  'recamera',
  'adjust_terrain',
  'adjust_material',
  'adjust_fog',
]);

export type CorrectionAction = z.infer<typeof correctionActionSchema>;

export const correctionSchema = z.object({
  action: correctionActionSchema,
  target: z.string(),
  params: z.record(z.unknown()).default({}),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type Correction = z.infer<typeof correctionSchema>;

export const comparisonResultSchema = z.object({
  overallSimilarity: z.number().min(0).max(1),
  differences: z.array(differenceSchema).default([]),
  corrections: z.array(correctionSchema).default([]),
  summary: z.string().default(''),
  method: z.enum(['vision_llm', 'heuristic']),
  warnings: z.array(z.string()).default([]),
});

export type ComparisonResult = z.infer<typeof comparisonResultSchema>;
