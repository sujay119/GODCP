import { getConfig, type GODCPConfig } from '../config.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { createVisionProvider } from '../vision/index.js';
import type { VisionProvider } from '../vision/VisionProvider.js';
import { MeshyProvider } from '../meshy/MeshyProvider.js';
import type { AssetGenerationProvider } from '../meshy/AssetGenerationProvider.js';
import { createUnityProvider } from '../unity/index.js';
import type { UnityProvider } from '../unity/UnityProvider.js';
import { AssetRegistry } from '../registry/AssetRegistry.js';
import { EnvironmentBuilder, type BuildInput } from '../orchestration/EnvironmentBuilder.js';
import { ReferenceAnalyzer } from '../vision/ReferenceAnalyzer.js';
import { SceneComparator } from '../vision/SceneComparator.js';
import { UnityRenderer } from '../unity/UnityRenderer.js';
import { createScenePlan } from '../planner/scenePlanner.js';
import { createAssetManifest } from '../planner/assetPlanner.js';
import { ProjectState } from '../registry/ProjectState.js';

export interface AppContext {
  config: GODCPConfig;
  logger: Logger;
  vision: VisionProvider;
  meshy: AssetGenerationProvider;
  unity: UnityProvider;
  registry: AssetRegistry;
  builder: EnvironmentBuilder;
}

let ctx: AppContext | undefined;

export function getAppContext(config?: GODCPConfig): AppContext {
  if (ctx) return ctx;
  const cfg = config ?? getConfig();
  const logger = createLogger('GODCP');
  const vision = createVisionProvider(cfg);
  const meshy = new MeshyProvider({
    apiKey: cfg.meshy.apiKey,
    baseUrl: cfg.meshy.baseUrl,
    cacheDir: cfg.paths.cacheDir,
    logger: logger.scope('Meshy'),
  });
  const unity = createUnityProvider({ config: cfg });
  const registry = new AssetRegistry(cfg.paths.stateDir, logger.scope('Registry'));

  const approvalFn = async (pending: Array<{ assetId: string; prompt?: string }>): Promise<boolean> => {
    if (process.env.GODCP_APPROVE_ALL === '1') return true;
    logger.warn(`Generation approval required for ${pending.length} asset(s) but no interactive approver is available. Set GODCP_APPROVE_ALL=1 to auto-approve, or run the CLI 'godcp build --approve' interactively.`, {
      pending: pending.map((p) => p.assetId),
    });
    return false;
  };

  const builder = new EnvironmentBuilder({
    config: cfg,
    vision,
    meshy,
    unity,
    registry,
    approvalFn,
    logger: logger.scope('Builder'),
  });

  ctx = { config: cfg, logger, vision, meshy, unity, registry, builder };
  return ctx;
}

export function resetAppContext(): void {
  ctx = undefined;
}

export function analyzer(c: AppContext): ReferenceAnalyzer {
  return new ReferenceAnalyzer(c.vision, c.logger.scope('Planner'));
}

export function comparator(c: AppContext): SceneComparator {
  return new SceneComparator(c.vision, c.logger.scope('Comparison'));
}

export function renderer(c: AppContext): UnityRenderer {
  return new UnityRenderer(c.unity, c.logger.scope('Render'));
}

export function projectState(c: AppContext, project: string): ProjectState {
  return new ProjectState(c.config.paths.stateDir, project, c.logger.scope('State'));
}

export function buildEnvironment(c: AppContext, input: BuildInput) {
  return c.builder.build(input);
}

export { createScenePlan, createAssetManifest };
