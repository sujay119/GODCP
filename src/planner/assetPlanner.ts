import type { ScenePlan, ReferenceAnalysis } from '../models/ScenePlan.js';
import { assetManifestSchema, type AssetManifest, type AssetSpec, type GenerationMethod } from '../models/AssetSpec.js';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { AssetPromptBuilder } from './assetPromptBuilder.js';

export interface AssetPlannerOptions {
  promptBuilder?: AssetPromptBuilder;
  logger?: Logger;
}

/** Categories that never need Meshy — procedural or primitive geometry wins. */
const PROCEDURAL_CATEGORIES = new Set(['terrain', 'road', 'sidewalk', 'water']);
const PRIMITIVE_TYPES: Record<string, AssetSpec['primitiveType']> = {
  bench: 'cube',
  bin: 'cube',
  crate: 'cube',
  barrel: 'cylinder',
  bollard: 'cylinder',
  pole: 'cylinder',
  sign: 'cube',
};

/**
 * Determines which scene objects become assets and how they are produced.
 * Prefers existing_asset → primitive → procedural → meshy_text/meshy_image.
 * Every object with the same type collapses to ONE reusable asset spec.
 */
export function createAssetManifest(
  plan: ScenePlan,
  analysis: ReferenceAnalysis | undefined,
  options: AssetPlannerOptions = {},
): AssetManifest {
  const log = options.logger ?? createLogger('AssetPlanner');
  const builder = options.promptBuilder ?? new AssetPromptBuilder();
  const warnings: string[] = [];
  const byKey = new Map<string, { spec: AssetSpec; objects: ScenePlan['objects'] }>();

  for (const obj of plan.objects) {
    if (obj.category === 'marker') continue;
    const key = `${obj.category}:${(obj.type || obj.name).toLowerCase()}`;

    if (byKey.has(key)) {
      const entry = byKey.get(key)!;
      entry.spec.quantity += 1;
      entry.spec.objectIds.push(obj.id);
      continue;
    }

    const method = decideMethod(obj.category, obj.type, obj.name);
    const spec: AssetSpec = {
      id: obj.assetId ?? obj.id,
      name: obj.name,
      category: obj.category,
      generationMethod: method.generationMethod,
      referenceImage: null,
      quantity: 1,
      reusable: true,
      estimatedComplexity: method.complexity ?? 'medium',
      priority: obj.importance >= 0.75 ? 'high' : obj.importance >= 0.45 ? 'medium' : 'low',
      objectIds: [obj.id],
      metadata: { importance: obj.importance, confidence: obj.confidence, sceneType: obj.type },
    };

    if (method.generationMethod === 'meshy_text') {
      const prompt = builder.build({ object: obj, analysis, visualStyle: plan.visualStyle });
      spec.prompt = prompt.prompt;
      spec.texturePrompt = prompt.texturePrompt;
    }
    if (method.generationMethod === 'meshy_image' && analysis?.sourceImage) {
      spec.referenceImage = analysis.sourceImage;
    }
    if (method.generationMethod === 'primitive') spec.primitiveType = method.primitive;
    if (method.generationMethod === 'procedural') spec.proceduralRecipe = method.recipe;

    byKey.set(key, { spec, objects: [obj] });
  }

  const assets = [...byKey.values()].map((e) => e.spec);

  // Meshy assets: keep only high-value items if the list would explode
  const meshyAssets = assets.filter((a) => a.generationMethod === 'meshy_text' || a.generationMethod === 'meshy_image');
  if (meshyAssets.length > 12) {
    warnings.push(`${meshyAssets.length} Meshy-eligible assets found — only the 12 highest-priority ones will be generated; the rest fall back to primitives.`);
    meshyAssets
      .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority))
      .slice(12)
      .forEach((a) => {
        a.generationMethod = 'primitive';
        a.primitiveType = 'cube';
        a.metadata = { ...a.metadata, fallbackReason: 'meshy budget cap (12 unique assets)' };
      });
  }

  const byMethod: Record<string, number> = {};
  for (const a of assets) byMethod[a.generationMethod] = (byMethod[a.generationMethod] ?? 0) + 1;

  const estimatedMeshyGenerations = assets.filter((a) => a.generationMethod === 'meshy_text' || a.generationMethod === 'meshy_image').length;
  // text-to-3d two-step = preview + refine calls; image = 1 call
  const estimatedMeshyCalls = assets.reduce((sum, a) => {
    if (a.generationMethod === 'meshy_text') return sum + 2;
    if (a.generationMethod === 'meshy_image') return sum + 1;
    return sum;
  }, 0);

  const manifest = assetManifestSchema.parse({
    schemaVersion: '1.0',
    project: plan.project,
    createdAt: new Date().toISOString(),
    assets,
    summary: {
      total: assets.length,
      byMethod,
      estimatedMeshyCalls,
      estimatedMeshyGenerations,
    },
    warnings,
  });

  log.info(`Found ${assets.length} scene objects.`, {
    meshy: estimatedMeshyGenerations,
    procedural: byMethod.procedural ?? 0,
    primitive: byMethod.primitive ?? 0,
    existing: byMethod.existing_asset ?? 0,
  });

  if (manifest.assets.length === 0) {
    throw new GODCPError('MANIFEST_INVALID', 'Asset manifest is empty — nothing to build.', { stage: 'manifest' });
  }
  return manifest;
}

function decideMethod(
  category: string,
  type: string,
  name: string,
): { generationMethod: GenerationMethod; complexity?: AssetSpec['estimatedComplexity']; primitive?: AssetSpec['primitiveType']; recipe?: AssetSpec['proceduralRecipe'] } {
  const t = `${type} ${name}`.toLowerCase();

  if (PROCEDURAL_CATEGORIES.has(category)) {
    const recipe = category === 'road' ? 'road' : category === 'sidewalk' ? 'sidewalk' : category === 'water' ? 'water_plane' : 'terrain_plane';
    return { generationMethod: 'procedural', recipe };
  }

  const primitive = PRIMITIVE_TYPES[t.split(/\s+/)[0]];
  if (primitive) return { generationMethod: 'primitive', primitive };

  if (category === 'building' || category === 'vehicle' || category === 'vegetation' || category === 'character') {
    return { generationMethod: 'meshy_text', complexity: category === 'building' ? 'high' : category === 'vehicle' ? 'high' : 'medium' };
  }
  if (category === 'prop') {
    if (t.includes('box') || t.includes('cube')) return { generationMethod: 'primitive', primitive: 'cube' };
    if (t.includes('sphere') || t.includes('rock') || t.includes('boulder')) return { generationMethod: 'primitive', primitive: 'sphere' };
    if (t.includes('pole') || t.includes('post') || t.includes('cylinder')) return { generationMethod: 'primitive', primitive: 'cylinder' };
    return { generationMethod: 'meshy_text', complexity: 'medium' };
  }
  return { generationMethod: 'meshy_text', complexity: 'low' };
}

function priorityRank(p: AssetSpec['priority']): number {
  return p === 'high' ? 3 : p === 'medium' ? 2 : 1;
}
