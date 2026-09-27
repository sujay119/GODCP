import { z } from 'zod';

export const generationMethodSchema = z.enum([
  'existing_asset',
  'primitive',
  'procedural',
  'meshy_text',
  'meshy_image',
  'manual',
  'unknown',
]);

export type GenerationMethod = z.infer<typeof generationMethodSchema>;

export const primitiveTypeSchema = z.enum(['cube', 'sphere', 'cylinder', 'plane', 'capsule', 'quad', 'cylinder_capsule']);

export type PrimitiveType = z.infer<typeof primitiveTypeSchema>;

export const proceduralRecipeSchema = z.enum([
  'road',
  'sidewalk',
  'terrain',
  'terrain_plane',
  'fence',
  'wall',
  'building_block',
  'crosswalk',
  'curb',
  'water_plane',
]);

export type ProceduralRecipe = z.infer<typeof proceduralRecipeSchema>;

export const assetSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  generationMethod: generationMethodSchema,
  /** Optimized Meshy prompt (only for meshy_text). */
  prompt: z.string().optional(),
  /** Texturing guidance for Meshy refine stage. */
  texturePrompt: z.string().optional(),
  /** Source image for meshy_image. */
  referenceImage: z.string().nullable().default(null),
  primitiveType: primitiveTypeSchema.optional(),
  proceduralRecipe: proceduralRecipeSchema.optional(),
  quantity: z.number().int().min(1).default(1),
  reusable: z.boolean().default(true),
  estimatedComplexity: z.enum(['low', 'medium', 'high']).default('medium'),
  priority: z.enum(['high', 'medium', 'low']).default('medium'),
  /** Scene object ids that consume this asset. */
  objectIds: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

export type AssetSpec = z.infer<typeof assetSpecSchema>;

export const assetManifestSchema = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),
  project: z.string().min(1),
  createdAt: z.string(),
  assets: z.array(assetSpecSchema),
  summary: z.object({
    total: z.number().int().min(0),
    byMethod: z.record(z.number()),
    estimatedMeshyCalls: z.number().int().min(0),
    estimatedMeshyGenerations: z.number().int().min(0),
  }),
  warnings: z.array(z.string()).default([]),
});

export type AssetManifest = z.infer<typeof assetManifestSchema>;

/** A Meshy generation request (internal, provider-agnostic). */
export interface MeshyGenerationSpec {
  assetId: string;
  prompt: string;
  texturePrompt?: string;
  name?: string;
  aiModel?: string;
  shouldTexture?: boolean;
  enablePbr?: boolean;
  targetFormats?: string[];
  targetPolycount?: number;
}

export interface MeshyImageGenerationSpec {
  assetId: string;
  /** Absolute path or data URI of the source image. */
  imageUrl: string;
  texturePrompt?: string;
  name?: string;
  aiModel?: string;
  shouldTexture?: boolean;
  enablePbr?: boolean;
  targetFormats?: string[];
}

export interface GeneratedAsset {
  assetId: string;
  files: string[];
  primaryFile: string;
  format: string;
  textureFiles: string[];
  thumbnailPath?: string;
  hash: string;
  sourceTaskId?: string;
  source: 'meshy' | 'cache' | 'registry';
  metadata: Record<string, unknown>;
}
