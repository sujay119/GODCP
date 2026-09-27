import { z } from 'zod';
import { comparisonResultSchema } from './ComparisonResult.js';
import type { StructuredErrorPayload } from '../utils/errors.js';

export const buildStageSchema = z.enum([
  'init',
  'analyzed',
  'planned',
  'manifested',
  'assets_ready',
  'imported',
  'constructed',
  'rendered',
  'completed',
  'failed',
]);

export type BuildStage = z.infer<typeof buildStageSchema>;

export const buildStateSchema = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),
  project: z.string(),
  sceneName: z.string(),
  referenceImage: z.string(),
  unityProject: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stage: buildStageSchema,
  completedStages: z.array(z.string()).default([]),
  iterationCount: z.number().int().min(0).default(0),
  meshyGenerationsUsed: z.number().int().min(0).default(0),
  meshyCallCount: z.number().int().min(0).default(0),
  assetsGenerated: z.number().int().min(0).default(0),
  assetsReused: z.number().int().min(0).default(0),
  proceduralObjects: z.number().int().min(0).default(0),
  lastSimilarity: z.number().min(0).max(1).optional(),
  dryRun: z.boolean().default(false),
  error: z.custom<StructuredErrorPayload>().optional(),
});

export type BuildState = z.infer<typeof buildStateSchema>;

export const iterationRecordSchema = z.object({
  iteration: z.number().int().min(1),
  timestamp: z.string(),
  renderPath: z.string().optional(),
  comparison: comparisonResultSchema,
  correctionsApplied: z.number().int().min(0),
  similarity: z.number().min(0).max(1),
});

export type IterationRecord = z.infer<typeof iterationRecordSchema>;

export const buildReportSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed', 'dry_run']),
  project: z.string(),
  scene: z.string(),
  referenceImage: z.string(),
  scenePlanPath: z.string().optional(),
  assetManifestPath: z.string().optional(),
  finalRenderPath: z.string().optional(),
  assetsGenerated: z.number().int().min(0),
  assetsReused: z.number().int().min(0),
  proceduralObjects: z.number().int().min(0),
  meshyCreditsSpent: z.number().int().min(0).default(0),
  iterations: z.number().int().min(0),
  finalSimilarity: z.number().min(0).max(1).optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().min(0),
  warnings: z.array(z.string()).default([]),
  error: z.custom<StructuredErrorPayload>().optional(),
});

export type BuildReport = z.infer<typeof buildReportSchema>;
