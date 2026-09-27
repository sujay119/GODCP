import { z } from 'zod';

export const vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export type Vec3 = z.infer<typeof vec3Schema>;

export const objectCategorySchema = z.enum([
  'terrain',
  'road',
  'sidewalk',
  'building',
  'vegetation',
  'prop',
  'vehicle',
  'character',
  'water',
  'marker',
]);

export type ObjectCategory = z.infer<typeof objectCategorySchema>;

/** A placed scene object (an instance in the world, not an asset). */
export const sceneObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: objectCategorySchema,
  type: z.string().min(1),
  position: vec3Schema,
  rotationY: z.number().default(0),
  scale: vec3Schema,
  quantity: z.number().int().min(1).optional(),
  /** 0..1 — how visually important this object is to matching the reference. */
  importance: z.number().min(0).max(1).default(0.5),
  /** 0..1 — confidence of the estimate derived from the reference. */
  confidence: z.number().min(0).max(1).default(0.5),
  assetId: z.string().optional(),
  notes: z.string().optional(),
});

export type SceneObject = z.infer<typeof sceneObjectSchema>;
