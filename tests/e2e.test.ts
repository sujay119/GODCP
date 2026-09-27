import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateExampleReference } from '../src/cli/exampleImage.js';
import { loadConfig } from '../src/config.js';
import { HeuristicVisionProvider } from '../src/vision/HeuristicVisionProvider.js';
import { MeshyProvider } from '../src/meshy/MeshyProvider.js';
import { MockUnityProvider } from '../src/unity/MockUnityProvider.js';
import { AssetRegistry } from '../src/registry/AssetRegistry.js';
import { EnvironmentBuilder } from '../src/orchestration/EnvironmentBuilder.js';
import { ProjectState } from '../src/registry/ProjectState.js';
import { pathExists } from '../src/utils/fileSystem.js';

/**
 * End-to-end: reference PNG → analysis → plan → manifest → (no Meshy key →
 * primitive fallback) → mock Unity construction → render → compare → report.
 * Fully offline; verifies resumability and report persistence.
 */
describe('environment build (e2e, mock Unity)', () => {
  let dir: string;
  let image: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'GODCP-e2e-'));
    image = await generateExampleReference(join(dir, 'reference.png'), 'e2e');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeBuilder() {
    const config = loadConfig(
      {
        MESHY_API_KEY: '',
        UNITY_MCP_PROFILE: 'mock',
        VISION_PROVIDER: 'heuristic',
        GODCP_ASSET_DIR: join(dir, 'assets'),
        GODCP_CACHE_DIR: join(dir, 'cache'),
        GODCP_RENDER_DIR: join(dir, 'renders'),
        GODCP_STATE_DIR: join(dir, 'state'),
        GODCP_MAX_ITERATIONS: '3',
        GODCP_MAX_MESHY_GENERATIONS: '0',
        LOG_LEVEL: 'silent',
      },
      dir,
    );
    const unity = new MockUnityProvider({});
    return new EnvironmentBuilder({
      config,
      vision: new HeuristicVisionProvider(),
      meshy: new MeshyProvider({ apiKey: config.meshy.apiKey, cacheDir: config.paths.cacheDir }),
      unity,
      registry: new AssetRegistry(config.paths.stateDir),
    });
  }

  it('completes a full build offline and persists the report', async () => {
    const builder = makeBuilder();
    const report = await builder.build({
      referenceImage: image,
      sceneName: 'E2EScene',
      project: 'e2e',
      maxIterations: 2,
      resume: false,
    });

    expect(report.status).toBe('completed');
    expect(report.iterations).toBeGreaterThanOrEqual(1);
    expect(report.finalSimilarity).toBeGreaterThan(0);
    expect(report.proceduralObjects + report.assetsReused + report.assetsGenerated).toBeGreaterThan(0);
    expect(await pathExists(report.finalRenderPath!)).toBe(true);
    expect(await pathExists(report.scenePlanPath!)).toBe(true);
    expect(await pathExists(report.assetManifestPath!)).toBe(true);

    // report persisted
    const state = new ProjectState(loadConfig({}, dir).paths.stateDir, 'e2e');
    const stored = await state.loadReport();
    expect(stored?.status).toBe('completed');
  });

  it('reuses stored state on a second run (resume)', async () => {
    const builder = makeBuilder();
    const report = await builder.build({ referenceImage: image, sceneName: 'E2EScene', project: 'e2e', maxIterations: 2 });
    // Completed build returns the stored report without re-running
    expect(report.status).toBe('completed');
  });

  it('dry run returns dry_run status without Unity/Meshy side effects', async () => {
    const builder = makeBuilder();
    const report = await builder.build({
      referenceImage: image,
      sceneName: 'DryScene',
      project: 'e2e-dry',
      dryRun: true,
      resume: false,
    });
    expect(report.status).toBe('dry_run');
    expect(report.finalRenderPath).toBeUndefined();
    expect(report.assetsGenerated).toBe(0);
  });

  it('fails with a structured error for a missing reference image', async () => {
    const builder = makeBuilder();
    const err = await builder
      .build({ referenceImage: join(dir, 'nope.png'), sceneName: 'BadScene', project: 'e2e-bad', resume: false })
      .catch((e) => e);
    expect(err).toBeTruthy();
    const structured = (err as { structured?: { error?: { errorCode?: string } } }).structured;
    expect(structured?.error?.errorCode).toBe('VISION_INVALID_IMAGE');
  });
});
