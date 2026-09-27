import { z } from 'zod';
import { sceneObjectSchema, vec3Schema, type SceneObject, type Vec3 } from './SceneObject.js';

export { vec3Schema };
export type { SceneObject, Vec3 };

export const hierarchyNodeSchema: z.ZodType<HierarchyNode> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    objectId: z.string().optional(),
    children: z.array(hierarchyNodeSchema).default([]),
  }),
) as unknown as z.ZodType<HierarchyNode>;

export interface HierarchyNode {
  name: string;
  objectId?: string;
  children: HierarchyNode[];
}

export const cameraPlanSchema = z.object({
  name: z.string().default('GODCPCamera'),
  position: vec3Schema,
  direction: vec3Schema.optional(),
  lookAt: vec3Schema.optional(),
  fov: z.number().min(5).max(179).default(50),
  near: z.number().min(0.01).default(0.1),
  far: z.number().min(1).default(2000),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type CameraPlan = z.infer<typeof cameraPlanSchema>;

export const lightingPlanSchema = z.object({
  sunDirection: vec3Schema,
  sunIntensity: z.number().min(0).max(20).default(1.2),
  sunColorHex: z.string().default('#fff4e0'),
  ambientIntensity: z.number().min(0).max(5).default(0.6),
  ambientColorHex: z.string().default('#8899aa'),
  fogEnabled: z.boolean().default(false),
  fogColorHex: z.string().default('#c9d6e3'),
  fogDensity: z.number().min(0).max(1).default(0.02),
  shadows: z.boolean().default(true),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type LightingPlan = z.infer<typeof lightingPlanSchema>;

export const atmosphereSchema = z.object({
  timeOfDay: z.string().default('day'),
  weather: z.string().default('clear'),
  mood: z.string().default('neutral'),
  fogColorHex: z.string().optional(),
  notes: z.string().optional(),
});

export type Atmosphere = z.infer<typeof atmosphereSchema>;

export const materialSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['standard', 'terrain', 'road', 'building', 'foliage', 'metal', 'glass', 'water', 'emissive']),
  colorHex: z.string().default('#808080'),
  roughness: z.number().min(0).max(1).optional(),
  metallic: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
});

export type MaterialSpec = z.infer<typeof materialSpecSchema>;

export const spatialRelationshipSchema = z.object({
  a: z.string(),
  relation: z.enum(['left_of', 'right_of', 'behind', 'in_front_of', 'above', 'below', 'near', 'adjacent_to']),
  b: z.string(),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type SpatialRelationship = z.infer<typeof spatialRelationshipSchema>;

export const scenePlanSchema = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),
  project: z.string().min(1),
  sceneName: z.string().min(1),
  environmentType: z.string().min(1),
  visualStyle: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  terrainType: z.enum(['flat', 'sloped', 'uneven', 'hilly', 'water', 'unknown']).default('flat'),
  worldSize: z
    .object({ width: z.number().positive().default(120), depth: z.number().positive().default(120) })
    .default({ width: 120, depth: 120 }),
  objects: z.array(sceneObjectSchema).default([]),
  spatialRelationships: z.array(spatialRelationshipSchema).default([]),
  hierarchy: hierarchyNodeSchema,
  camera: cameraPlanSchema,
  lighting: lightingPlanSchema,
  atmosphere: atmosphereSchema.default({}),
  materials: z.array(materialSpecSchema).default([]),
  /** ids of objects that should become assets (does not imply Meshy). */
  assetRequirements: z.array(z.string()).default([]),
  reuseOpportunities: z
    .array(
      z.object({
        objectId: z.string(),
        reason: z.string(),
        instances: z.number().int().min(1),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
});

export type ScenePlan = z.infer<typeof scenePlanSchema>;

// ── Reference analysis ────────────────────────────────────────────────────

export const referenceObjectSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  estimatedPosition: vec3Schema.optional(),
  estimatedScale: vec3Schema.optional(),
  notes: z.string().optional(),
});

export type ReferenceObject = z.infer<typeof referenceObjectSchema>;

export const referenceAnalysisSchema = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),
  sourceImage: z.string(),
  environmentType: z.string().min(1),
  visualStyle: z.string().min(1),
  composition: z.object({
    cameraPosition: vec3Schema,
    cameraDirection: vec3Schema,
    estimatedFov: z.number().min(5).max(179),
    confidence: z.number().min(0).max(1).default(0.5),
  }),
  geometry: z.object({
    terrain: z.enum(['flat', 'sloped', 'uneven', 'hilly', 'water', 'unknown']),
    road: z.boolean().default(false),
    sidewalk: z.boolean().default(false),
    buildings: z.boolean().default(false),
    vegetation: z.boolean().default(false),
    water: z.boolean().default(false),
    vehicles: z.boolean().default(false),
    bridge: z.boolean().default(false),
  }),
  objects: z.array(referenceObjectSchema).default([]),
  lighting: z.object({
    timeOfDay: z.string().default('day'),
    direction: vec3Schema.optional(),
    intensityHint: z.enum(['dim', 'normal', 'bright']).default('normal'),
    shadows: z.boolean().default(true),
    confidence: z.number().min(0).max(1).default(0.5),
  }),
  colors: z.object({
    dominant: z.array(z.string()).default([]),
    accent: z.array(z.string()).default([]),
    averageHex: z.string().optional(),
  }),
  materials: z
    .array(z.object({ name: z.string(), kind: z.string(), confidence: z.number().min(0).max(1).default(0.5) }))
    .default([]),
  atmosphere: z.object({
    fog: z.boolean().default(false),
    haze: z.boolean().default(false),
    weather: z.string().default('clear'),
    mood: z.string().default('neutral'),
  }),
  compositionNotes: z.array(z.string()).default([]),
  /** Overall confidence that this analysis faithfully reflects the image. */
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string()).default([]),
});

export type ReferenceAnalysis = z.infer<typeof referenceAnalysisSchema>;
