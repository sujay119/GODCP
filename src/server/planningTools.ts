import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAppContext, analyzer, projectState, createScenePlan, createAssetManifest,  } from './context.js';
import { run } from './toolHelpers.js';

export function registerPlanningTools(server: McpServer): void {
  server.registerTool(
    'godcp_create_scene_plan',
    {
      title: 'Create scene plan from reference',
      description:
        'Analyze a reference image (unless project state already has an analysis) and produce a ScenePlan: objects with transforms/categories/importance, materials, camera, lighting, fog. Persists analysis + plan to project state for resumable builds.',
      inputSchema: {
        referenceImage: z.string().describe('Path to the reference image.'),
        project: z.string().optional().describe('Project slug (default derived from sceneName).'),
        sceneName: z.string().optional().describe('Unity scene name (default GeneratedEnvironment).'),
        style: z.string().optional().describe('Optional target style hint.'),
        force: z.boolean().optional().describe('Re-analyze and re-plan even if state exists.'),
      },
    },
    async ({ referenceImage, project, sceneName, style, force }) =>
      run('planning', async () => {
        const ctx = getAppContext();
        const name = sceneName ?? 'GeneratedEnvironment';
        const slug = (project ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'environment';
        const state = projectState(ctx, slug);

        let analysis = force ? undefined : await state.loadAnalysis();
        if (!analysis) {
          analysis = await analyzer(ctx).analyze(referenceImage, [`target style: ${style ?? 'match_reference'}`]);
          await state.init({ referenceImage, sceneName: name });
          await state.saveAnalysis(analysis);
        }

        let plan = force ? undefined : await state.loadPlan();
        if (!plan) {
          plan = createScenePlan({ project: slug, sceneName: name, analysis });
          await state.savePlan(plan);
        }
        return { project: slug, analysisPath: state.paths.referenceAnalysis, planPath: state.paths.scenePlan, plan };
      }),
  );

  server.registerTool(
    'godcp_create_asset_manifest',
    {
      title: 'Create asset manifest from scene plan',
      description:
        'Turn the stored ScenePlan into an AssetManifest: which objects need Meshy text-to-3D / image-to-3D, which are procedural or primitive, with prompts, objectIds and estimated API calls. Persists to project state.',
      inputSchema: {
        project: z.string().describe('Project slug whose scene plan should be used.'),
        force: z.boolean().optional().describe('Regenerate manifest even if one exists.'),
      },
    },
    async ({ project, force }) =>
      run('manifest', async () => {
        const ctx = getAppContext();
        const state = projectState(ctx, project);
        const plan = await state.loadPlan();
        if (!plan) {
          const { GODCPError } = await import('../utils/errors.js');
          throw new GODCPError('PLAN_MISSING', `No scene plan found for project "${project}". Run godcp_create_scene_plan first.`, { stage: 'manifest' });
        }
        let manifest = force ? undefined : await state.loadManifest();
        if (!manifest) {
          manifest = createAssetManifest(plan, await state.loadAnalysis(), { logger: ctx.logger.scope('AssetPlanner') });
          await state.saveManifest(manifest);
        }
        return { project: state.project, manifestPath: state.paths.assetManifest, manifest };
      }),
  );

  server.registerTool(
    'godcp_get_build_status',
    {
      title: 'Get build status / project state',
      description: 'Return the persisted BuildState, iteration records and comparison history for a project (auditability/resume).',
      inputSchema: { project: z.string().describe('Project slug.') },
    },
    async ({ project }) =>
      run('state', async () => {
        const ctx = getAppContext();
        const state = projectState(ctx, project);
        const [buildState, iterations, history, report] = await Promise.all([
          state.loadState(),
          state.loadIterations(),
          state.loadComparisonHistory(),
          state.loadReport(),
        ]);
        if (!buildState) {
          const { GODCPError } = await import('../utils/errors.js');
          throw new GODCPError('PROJECT_NOT_FOUND', `No build state for project "${project}".`, { stage: 'state' });
        }
        return {
          project: state.project,
          state: buildState,
          iterations,
          comparisons: history,
          report,
          paths: state.paths,
        };
      }),
  );
}
