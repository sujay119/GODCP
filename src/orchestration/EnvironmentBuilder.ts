import { basename, join } from 'node:path';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { ensureDir, pathExists } from '../utils/fileSystem.js';
import type { GODCPConfig } from '../config.js';
import type { ReferenceAnalysis, ScenePlan } from '../models/ScenePlan.js';
import type { AssetManifest } from '../models/AssetSpec.js';
import type { BuildReport, BuildState } from '../models/BuildReport.js';
import type { VisionProvider } from '../vision/VisionProvider.js';
import { ReferenceAnalyzer } from '../vision/ReferenceAnalyzer.js';
import { SceneComparator } from '../vision/SceneComparator.js';
import type { AssetGenerationProvider } from '../meshy/AssetGenerationProvider.js';
import type { UnityProvider } from '../unity/UnityProvider.js';
import { UnityRenderer } from '../unity/UnityRenderer.js';
import { AssetRegistry } from '../registry/AssetRegistry.js';
import { ProjectState } from '../registry/ProjectState.js';
import { createScenePlan } from '../planner/scenePlanner.js';
import { createAssetManifest } from '../planner/assetPlanner.js';
import { AssetPipeline } from './AssetPipeline.js';
import { ScenePipeline } from './ScenePipeline.js';
import { IterationEngine } from './IterationEngine.js';

export interface EnvironmentBuilderOptions {
  config: GODCPConfig;
  vision: VisionProvider;
  meshy: AssetGenerationProvider;
  unity: UnityProvider;
  registry: AssetRegistry;
  /** Optional custom approval handler for generation approval mode. */
  approvalFn?: (pending: Array<{ assetId: string; prompt?: string }>) => Promise<boolean>;
  logger?: Logger;
}

export interface BuildInput {
  referenceImage: string;
  /** Unity project path (also used to copy imported assets). */
  unityProject?: string;
  sceneName?: string;
  project?: string;
  style?: string;
  maxIterations?: number;
  assetQuality?: 'draft' | 'standard' | 'high';
  dryRun?: boolean;
  maxMeshyGenerations?: number;
  /** Resume an interrupted build if state exists (default true). */
  resume?: boolean;
}

/**
 * The full pipeline:
 * validate → analyze → plan → manifest → resolve assets → import → construct
 * → camera/lighting/materials → save → render → compare → correct → …
 */
export class EnvironmentBuilder {
  private readonly log: Logger;

  constructor(private readonly options: EnvironmentBuilderOptions) {
    this.log = options.logger ?? createLogger('Builder');
  }

  async build(input: BuildInput): Promise<BuildReport> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const { config, registry, meshy, unity, vision } = this.options;

    const projectName = slug(input.project ?? basename(input.sceneName ?? 'environment') ?? 'environment');
    const sceneName = input.sceneName ?? 'GeneratedEnvironment';
    const maxIterations = Math.max(1, input.maxIterations ?? config.budget.maxIterations);
    const budget = {
      ...config.budget,
      maxIterations,
      dryRun: input.dryRun ?? config.budget.dryRun,
      maxMeshyGenerations: input.maxMeshyGenerations ?? config.budget.maxMeshyGenerations,
    };

    const state = new ProjectState(config.paths.stateDir, projectName, this.log.scope('State'));
    const warnings: string[] = [];

    let buildState: BuildState | undefined;
    let analysis: ReferenceAnalysis | undefined;
    let plan: ScenePlan | undefined;
    let manifest: AssetManifest | undefined;
    let finalSimilarity: number | undefined;
    let finalRenderPath: string | undefined;
    let proceduralObjects = 0;
    let assetsGenerated = 0;
    let assetsReused = 0;
    let iterations = 0;
    let creditsSpent = 0;
    let error: BuildReport['error'];

    try {
      // 0) Validate reference
      if (!input.referenceImage || !(await pathExists(input.referenceImage))) {
        throw new GODCPError('VISION_INVALID_IMAGE', `Reference image not found: ${input.referenceImage}`, { stage: 'validate' });
      }

      if (input.resume === false) await state.reset();
      buildState = await state.init({
        referenceImage: input.referenceImage,
        sceneName,
        unityProject: input.unityProject ?? config.unity.projectPath,
        dryRun: budget.dryRun,
      });

      if (buildState.stage === 'completed' && input.resume !== false) {
        const report = await state.loadReport();
        if (report) {
          this.log.info('Build already completed — returning stored report (pass resume:false to rebuild).');
          return report;
        }
      }

      const renderDir = join(config.paths.renderDir, projectName);
      const assetDir = join(config.paths.assetDir, projectName);
      await ensureDir(renderDir);
      await ensureDir(assetDir);
      // 1-2) Analyze
      if (state.hasCompleted(buildState, 'analyzed')) {
        analysis = await state.loadAnalysis();
        this.log.info('Reusing stored reference analysis.');
      }
      if (!analysis) {
        const analyzer = new ReferenceAnalyzer(vision, this.log.scope('Planner'));
        analysis = await analyzer.analyze(input.referenceImage, [`target style: ${input.style ?? 'match_reference'}`]);
        await state.saveAnalysis(analysis);
        buildState = await state.markStage(buildState, 'analyzed');
      }

      // 3) Scene plan
      if (state.hasCompleted(buildState, 'planned')) {
        plan = await state.loadPlan();
        this.log.info('Reusing stored scene plan.');
      }
      if (!plan) {
        plan = createScenePlan({ project: projectName, sceneName, analysis });
        await state.savePlan(plan);
        buildState = await state.markStage(buildState, 'planned');
      }

      // 4) Asset manifest
      if (state.hasCompleted(buildState, 'manifested')) {
        manifest = await state.loadManifest();
      }
      if (!manifest) {
        manifest = createAssetManifest(plan, analysis, { logger: this.log.scope('AssetPlanner') });
        await state.saveManifest(manifest);
        buildState = await state.markStage(buildState, 'manifested');
      }

      // 5-10) Resolve assets (registry reuse → cache → Meshy generation → download)
      const pipeline = new AssetPipeline({
        registry,
        provider: meshy,
        budget,
        outputDir: assetDir,
        approvalFn: this.options.approvalFn,
        logger: this.log.scope('AssetPipeline'),
      });
      const assetResult = await pipeline.resolve(manifest, {
        meshyGenerationsUsed: buildState.meshyGenerationsUsed,
        meshyCallCount: buildState.meshyCallCount,
      });
      warnings.push(...assetResult.warnings);
      assetsGenerated = assetResult.generated.length;
      assetsReused = assetResult.reused.length;
      proceduralObjects = assetResult.proceduralCount + assetResult.primitiveCount;
      creditsSpent = assetResult.creditsSpent;

      buildState = await state.markStage(
        { ...buildState, meshyGenerationsUsed: assetResult.meshyGenerationsUsed, meshyCallCount: assetResult.meshyCallCount, assetsGenerated, assetsReused, proceduralObjects },
        'assets_ready',
      );

      if (budget.dryRun) {
        const report = this.finish({ status: 'dry_run', projectName, sceneName, input, state, startedAt, startMs, plan, manifest, finalRenderPath, assetsGenerated, assetsReused, proceduralObjects, creditsSpent, iterations, warnings, finalSimilarity });
        await state.saveReport(report);
        return report;
      }

      // 11-16) Import + construct + camera/lighting/materials + save
      const scenePipeline = new ScenePipeline({
        unity,
        unityProjectPath: input.unityProject ?? config.unity.projectPath,
        logger: this.log.scope('Unity'),
      });
      await unity.connect().catch(() => undefined);
      const buildResult = await scenePipeline.build(plan, manifest, assetResult.localPaths);
      warnings.push(...buildResult.warnings);
      proceduralObjects = buildResult.proceduralObjects + buildResult.primitivesCreated;
      buildState = await state.markStage(buildState, 'constructed');

      // 17-22) Render/compare/correct loop
      const renderer = new UnityRenderer(unity, this.log.scope('Render'));
      const comparator = new SceneComparator(vision, this.log.scope('Comparison'));
      const engine = new IterationEngine({
        comparator,
        renderer,
        pipeline: scenePipeline,
        state,
        renderDir,
        referenceImagePath: input.referenceImage,
        maxIterations,
        similarityTarget: config.budget.similarityTarget,
        logger: this.log.scope('Iteration'),
      });
      const { outcome, plan: finalPlan } = await engine.run(plan, assetResult.localPaths, Math.max(1, buildState.iterationCount + 1));
      plan = finalPlan;
      iterations = outcome.iterations;
      finalSimilarity = outcome.finalSimilarity;
      finalRenderPath = outcome.finalRenderPath;
      warnings.push(...outcome.warnings);

      buildState = await state.markStage({ ...buildState, iterationCount: iterations, lastSimilarity: finalSimilarity }, 'completed');
      await state.savePlan(plan);

      const report = this.finish({
        status: 'completed',
        projectName,
        sceneName,
        input,
        state,
        startedAt,
        startMs,
        plan,
        manifest,
        finalRenderPath,
        assetsGenerated,
        assetsReused,
        proceduralObjects,
        creditsSpent,
        iterations,
        warnings,
        finalSimilarity,
      });
      await state.saveReport(report);
      this.log.info(`Build completed: ${report.status}, ${iterations} iteration(s), similarity ${finalSimilarity !== undefined ? (finalSimilarity * 100).toFixed(0) + '%' : 'n/a'}.`);
      return report;
    } catch (err) {
      error = GODCPError.from(err, 'build').toJSON();
      this.log.error(`Build failed at stage "${error.stage}": ${error.message}`);
      const failedState =
        buildState ??
        (await state
          .init({ referenceImage: input.referenceImage, sceneName, unityProject: input.unityProject ?? config.unity.projectPath, dryRun: budget.dryRun })
          .catch(() => undefined));
      if (failedState) await state.markStage({ ...failedState, stage: 'failed', error }, 'failed');
      const report = this.finish({
        status: 'failed',
        projectName,
        sceneName,
        input,
        state,
        startedAt,
        startMs,
        plan,
        manifest,
        finalRenderPath,
        assetsGenerated,
        assetsReused,
        proceduralObjects,
        creditsSpent,
        iterations,
        warnings,
        finalSimilarity,
        error,
      });
      await state.saveReport(report).catch(() => undefined);
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { structured: report });
    }
  }

  private finish(args: {
    status: BuildReport['status'];
    projectName: string;
    sceneName: string;
    input: BuildInput;
    state: ProjectState;
    startedAt: string;
    startMs: number;
    plan?: ScenePlan;
    manifest?: AssetManifest;
    finalRenderPath?: string;
    assetsGenerated: number;
    assetsReused: number;
    proceduralObjects: number;
    creditsSpent: number;
    iterations: number;
    warnings: string[];
    finalSimilarity?: number;
    error?: BuildReport['error'];
  }): BuildReport {
    return {
      status: args.status,
      project: args.projectName,
      scene: args.sceneName,
      referenceImage: args.input.referenceImage,
      scenePlanPath: args.plan ? args.state.paths.scenePlan : undefined,
      assetManifestPath: args.manifest ? args.state.paths.assetManifest : undefined,
      finalRenderPath: args.finalRenderPath,
      assetsGenerated: args.assetsGenerated,
      assetsReused: args.assetsReused,
      proceduralObjects: args.proceduralObjects,
      meshyCreditsSpent: Math.round(args.creditsSpent),
      iterations: args.iterations,
      finalSimilarity: args.finalSimilarity,
      startedAt: args.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - args.startMs,
      warnings: args.warnings,
      error: args.error,
    };
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'environment';
}
