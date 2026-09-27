#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { getConfig, resetConfigCache } from '../config.js';
import { getAppContext, analyzer, projectState, buildEnvironment, renderer, comparator, createScenePlan, createAssetManifest, resetAppContext } from '../server/context.js';
import { AssetPipeline } from '../orchestration/AssetPipeline.js';
import { GODCPError } from '../utils/errors.js';
import { pathExists } from '../utils/fileSystem.js';
import { SERVER_VERSION } from '../server/mcpServer.js';

const program = new Command();

program
  .name('godcp')
  .description('GODCP CLI — reference image → Meshy 3D assets → Unity environment')
  .version(SERVER_VERSION);

function ctx() {
  return getAppContext(getConfig());
}

function print(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else if (typeof data === 'string') {
    process.stdout.write(`${data}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

function handleError(err: unknown, stage: string): never {
  const e = GODCPError.from(err, stage);
  process.stderr.write(`${JSON.stringify(e.toJSON(), null, 2)}\n`);
  process.exit(1);
}

program
  .command('analyze')
  .description('Analyze a reference environment image')
  .argument('<image>', 'Path to reference image')
  .option('--hint <hint>', 'Repeatable analysis hint', collect, [])
  .option('--json', 'Raw JSON output')
  .action(async (image: string, opts: { hint: string[]; json?: boolean }) => {
    try {
      const analysis = await analyzer(ctx()).analyze(resolve(image), opts.hint);
      print(analysis, true);
    } catch (err) { handleError(err, 'vision'); }
  });

program
  .command('plan')
  .description('Analyze image and produce a persisted scene plan')
  .argument('<image>', 'Path to reference image')
  .option('-p, --project <slug>', 'Project slug')
  .option('-s, --scene <name>', 'Unity scene name', 'GeneratedEnvironment')
  .option('--style <style>', 'Target style hint')
  .action(async (image: string, opts: { project?: string; scene: string; style?: string }) => {
    try {
      const c = ctx();
      const project = opts.project ?? opts.scene;
      const analysis = await analyzer(c).analyze(resolve(image), [`target style: ${opts.style ?? 'match_reference'}`]);
      const state = projectState(c, project);
      await state.init({ referenceImage: resolve(image), sceneName: opts.scene });
      await state.saveAnalysis(analysis);
      const plan = createScenePlan({ project: state.project, sceneName: opts.scene, analysis });
      await state.savePlan(plan);
      print({ project: state.project, planPath: state.paths.scenePlan, objects: plan.objects.length, plan }, true);
    } catch (err) { handleError(err, 'planning'); }
  });

program
  .command('manifest')
  .description('Create the asset manifest for a project')
  .argument('<project>', 'Project slug')
  .action(async (project: string) => {
    try {
      const c = ctx();
      const state = projectState(c, project);
      const plan = await state.loadPlan();
      if (!plan) throw new GODCPError('PLAN_MISSING', `No scene plan for "${project}". Run "godcp plan <image>" first.`, { stage: 'manifest' });
      const manifest = createAssetManifest(plan, await state.loadAnalysis(), { logger: c.logger.scope('AssetPlanner') });
      await state.saveManifest(manifest);
      print({ project: state.project, manifestPath: state.paths.assetManifest, summary: manifest.summary, assets: manifest.assets.map((a) => ({ id: a.id, method: a.generationMethod })) }, true);
    } catch (err) { handleError(err, 'manifest'); }
  });

program
  .command('generate')
  .description('Generate missing Meshy assets for a project (budgeted, registry-aware)')
  .argument('<project>', 'Project slug')
  .option('--dry-run', 'Do not call Meshy; report what would happen')
  .option('--approve', 'Auto-approve pending generations (approval mode)')
  .option('--max <n>', 'Generation budget override', (v) => parseInt(v, 10))
  .action(async (project: string, opts: { dryRun?: boolean; approve?: boolean; max?: number }) => {
    try {
      const c = ctx();
      const state = projectState(c, project);
      const manifest = await state.loadManifest();
      if (!manifest) throw new GODCPError('MANIFEST_MISSING', `No manifest for "${project}". Run "godcp manifest ${project}" first.`, { stage: 'manifest' });
      if (!opts.dryRun && !c.meshy.isConfigured()) throw new GODCPError('MESHY_NOT_CONFIGURED', 'MESHY_API_KEY not set � cannot generate. Use --dry-run to preview.', { stage: 'asset_generation' });
      const buildState = await state.loadState();
      const pipeline = new AssetPipeline({
        registry: c.registry,
        provider: c.meshy,
        budget: { ...c.config.budget, dryRun: opts.dryRun ?? false, maxMeshyGenerations: opts.max ?? c.config.budget.maxMeshyGenerations },
        outputDir: `${c.config.paths.assetDir}/${state.project}`,
        approvalFn: opts.approve ? async () => true : undefined,
        logger: c.logger.scope('AssetPipeline'),
      });
      const result = await pipeline.resolve(manifest, {
        meshyGenerationsUsed: buildState?.meshyGenerationsUsed,
        meshyCallCount: buildState?.meshyCallCount,
      });
      if (buildState) {
        await state.saveState({ ...buildState, meshyGenerationsUsed: result.meshyGenerationsUsed, meshyCallCount: result.meshyCallCount });
      }
      print({
        generated: result.generated.map((g) => g.primaryFile),
        reused: result.reused,
        skipped: result.skipped,
        creditsSpent: result.creditsSpent,
        warnings: result.warnings,
      }, true);
    } catch (err) { handleError(err, 'asset_generation'); }
  });

program
  .command('build')
  .description('Full pipeline: reference image → Unity environment → comparison iterations')
  .argument('<image>', 'Path to reference image')
  .option('-p, --project <slug>', 'Project slug')
  .option('-s, --scene <name>', 'Unity scene name', 'GeneratedEnvironment')
  .option('-u, --unity <path>', 'Unity project root')
  .option('--style <style>', 'Target style hint')
  .option('-i, --iterations <n>', 'Max render/compare/correct iterations', (v) => parseInt(v, 10))
  .option('--max-generations <n>', 'Meshy generation budget override', (v) => parseInt(v, 10))
  .option('--dry-run', 'Plan only; no Meshy generation, no Unity writes')
  .option('--fresh', 'Ignore previous state (force full rebuild)')
  .action(async (image: string, opts: any) => {
    try {
      const report = await buildEnvironment(ctx(), {
        referenceImage: resolve(image),
        unityProject: opts.unity ? resolve(opts.unity) : undefined,
        sceneName: opts.scene,
        project: opts.project,
        style: opts.style,
        maxIterations: opts.iterations,
        maxMeshyGenerations: opts.maxGenerations,
        dryRun: opts.dryRun,
        resume: !opts.fresh,
      });
      print(report, true);
      process.exit(report.status === 'failed' ? 1 : 0);
    } catch (err) {
      const e = GODCPError.from(err, 'build');
      const structured = (err as { structured?: unknown }).structured;
      process.stderr.write(`${JSON.stringify(structured ?? e.toJSON(), null, 2)}\n`);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show build state/iterations/comparisons for a project')
  .argument('<project>', 'Project slug')
  .action(async (project: string) => {
    try {
      const c = ctx();
      const state = projectState(c, project);
      const [buildState, iterations, report] = await Promise.all([state.loadState(), state.loadIterations(), state.loadReport()]);
      if (!buildState) throw new GODCPError('PROJECT_NOT_FOUND', `No state for "${project}".`, { stage: 'state' });
      print({ state: buildState, iterations: iterations.length, lastSimilarity: buildState.lastSimilarity, report }, true);
    } catch (err) { handleError(err, 'state'); }
  });

program
  .command('report')
  .description('Print the BuildReport for a project')
  .argument('<project>', 'Project slug')
  .action(async (project: string) => {
    try {
      const state = projectState(ctx(), project);
      const report = await state.loadReport();
      if (!report) throw new GODCPError('REPORT_MISSING', `No report for "${project}".`, { stage: 'state' });
      print(report, true);
    } catch (err) { handleError(err, 'state'); }
  });

program
  .command('assets')
  .description('List registry assets')
  .option('-q, --query <text>', 'Substring filter')
  .option('-c, --category <category>', 'Category filter')
  .option('--limit <n>', 'Max entries', (v) => parseInt(v, 10))
  .action(async (opts: { query?: string; category?: string; limit?: number }) => {
    try {
      const c = ctx();
      const all = await c.registry.list();
      const q = opts.query?.toLowerCase();
      const filtered = all
        .filter((e) => !opts.category || e.category === opts.category)
        .filter((e) => !q || `${e.id} ${e.description} ${(e.tags ?? []).join(' ')}`.toLowerCase().includes(q))
        .slice(0, opts.limit ?? 100);
      print({ total: all.length, assets: filtered }, true);
    } catch (err) { handleError(err, 'registry'); }
  });

program
  .command('capture')
  .description('Capture a render from Unity (mock render if Unity MCP is not configured)')
  .argument('[output]', 'Destination PNG path')
  .action(async (output?: string) => {
    try {
      const c = ctx();
      const dest = output ? resolve(output) : `${c.config.paths.renderDir}/manual-${Date.now()}.png`;
      const path = await renderer(c).render(dest);
      print({ renderPath: path, unityProfile: c.config.unity.profile }, true);
    } catch (err) { handleError(err, 'render'); }
  });

program
  .command('compare')
  .description('Compare a render against the reference')
  .argument('<reference>', 'Reference image path')
  .argument('<render>', 'Render image path')
  .action(async (ref: string, render: string) => {
    try {
      const c = ctx();
      const result = await comparator(c).compare(resolve(ref), resolve(render));
      print(result, true);
    } catch (err) { handleError(err, 'comparison'); }
  });

program
  .command('doctor')
  .description('Check configuration, keys, and connectivity')
  .action(async () => {
    try {
      const c = ctx();
      const checks: Record<string, unknown> = {
        version: SERVER_VERSION,
        config: {
          vision: c.config.vision.provider,
          unityProfile: c.config.unity.profile,
          unityUrl: c.config.unity.url ?? null,
          transport: c.config.transport,
          budget: c.config.budget,
        },
        meshy: {
          keyPresent: Boolean(c.config.meshy.apiKey),
          baseUrl: c.config.meshy.baseUrl,
        },
        registry: { entries: await c.registry.count() },
        unity: { available: await c.unity.isAvailable().catch(() => false) },
      };
      const issues: string[] = [];
      if (!c.config.meshy.apiKey) issues.push('MESHY_API_KEY not set — Meshy generation is skipped (primitive fallbacks + registry reuse still work; `generate` requires a key).');
      if (c.config.vision.provider === 'openai' && !c.config.vision.apiKey) issues.push('VISION_PROVIDER=openai but VISION_API_KEY missing — falling back may fail.');
      if (c.config.unity.profile !== 'mock' && !c.config.unity.url && !c.config.unity.command) issues.push('Unity MCP not configured — mock renderer will be used. Set UNITY_MCP_URL or UNITY_MCP_COMMAND.');
      print({ ok: issues.length === 0, issues, checks }, true);
    } catch (err) { handleError(err, 'doctor'); }
  });

program
  .command('demo')
  .description('End-to-end offline demo: generate a synthetic reference PNG and run a full (mock) build')
  .option('--image <path>', 'Use an existing reference image instead of generating one')
  .option('-i, --iterations <n>', 'Max iterations', (v) => parseInt(v, 10))
  .action(async (opts: { image?: string; iterations?: number }) => {
    try {
      const c = ctx();
      let image = opts.image ? resolve(opts.image) : undefined;
      if (!image) {
        const { generateExampleReference } = await import('./exampleImage.js');
        image = await generateExampleReference(resolve('assets/references/example-reference.png'));
        print(`Generated example reference: ${image}`, false);
      }
      const report = await buildEnvironment(c, {
        referenceImage: image,
        sceneName: 'GODCPDemo',
        project: 'demo',
        maxIterations: opts.iterations ?? 2,
        resume: false,
      });
      print(report, true);
      process.exit(report.status === 'failed' ? 1 : 0);
    } catch (err) {
      const structured = (err as { structured?: unknown }).structured ?? GODCPError.from(err, 'demo').toJSON();
      process.stderr.write(`${JSON.stringify(structured, null, 2)}\n`);
      process.exit(1);
    }
  });

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// Reset memoized config/context if env changed (useful in tests + watch mode)
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
void pathExists;
void resetConfigCache;
void resetAppContext;

program.parseAsync(process.argv).catch((err) => {
  handleError(err, 'cli');
});
