import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateExampleReference } from '../src/cli/exampleImage.js';
import { HeuristicVisionProvider } from '../src/vision/HeuristicVisionProvider.js';
import { ReferenceAnalyzer } from '../src/vision/ReferenceAnalyzer.js';
import { createScenePlan } from '../src/planner/scenePlanner.js';
import { createAssetManifest } from '../src/planner/assetPlanner.js';
import { referenceAnalysisSchema, scenePlanSchema } from '../src/models/ScenePlan.js';
import { assetManifestSchema } from '../src/models/AssetSpec.js';
import { planLighting } from '../src/planner/lightingPlanner.js';

describe('planning pipeline', () => {
  let dir: string;
  let image: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'GODCP-plan-'));
    image = await generateExampleReference(join(dir, 'ref.png'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('heuristic analysis produces a valid ReferenceAnalysis', async () => {
    const analysis = await new ReferenceAnalyzer(new HeuristicVisionProvider()).analyze(image);
    const parsed = referenceAnalysisSchema.safeParse(analysis);
    expect(parsed.success).toBe(true);
    expect(analysis.environmentType).toBeTruthy();
    expect(analysis.confidence).toBeGreaterThan(0);
    expect(analysis.objects.length).toBeGreaterThan(0);
  });

  it('scene plan is valid and structurally complete', async () => {
    const analysis = await new ReferenceAnalyzer(new HeuristicVisionProvider()).analyze(image);
    const plan = createScenePlan({ project: 'test', sceneName: 'TestScene', analysis });
    const parsed = scenePlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
    expect(plan.objects.some((o) => o.category === 'terrain')).toBe(true);
    expect(plan.objects.length).toBeGreaterThanOrEqual(4);
    expect(plan.camera.position).toBeDefined();
    expect(plan.lighting.sunIntensity).toBeGreaterThan(0);
    expect(plan.hierarchy.name).toBe('TestScene');
  });

  it('asset manifest groups objects and estimates Meshy calls', async () => {
    const analysis = await new ReferenceAnalyzer(new HeuristicVisionProvider()).analyze(image);
    const plan = createScenePlan({ project: 'test', sceneName: 'TestScene', analysis });
    const manifest = createAssetManifest(plan, analysis);
    const parsed = assetManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
    expect(manifest.assets.length).toBeGreaterThan(0);
    expect(manifest.summary.total).toBe(manifest.assets.length);
    for (const a of manifest.assets) {
      expect(['meshy_text', 'meshy_image', 'procedural', 'primitive', 'existing_asset', 'manual']).toContain(a.generationMethod);
      if (a.generationMethod.startsWith('meshy')) expect(a.prompt ?? a.texturePrompt).toBeTruthy();
    }
  });

  it('planLighting is valid and normalized', async () => {
    const analysis = await new ReferenceAnalyzer(new HeuristicVisionProvider()).analyze(image);
    const lighting = planLighting(analysis);
    expect(lighting.sunIntensity).toBeGreaterThan(0);
    const len = Math.hypot(lighting.sunDirection.x, lighting.sunDirection.y, lighting.sunDirection.z);
    expect(len).toBeCloseTo(1, 2);
    expect(lighting.fogColorHex).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
