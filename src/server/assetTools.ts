import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAppContext, projectState } from './context.js';
import { run } from './toolHelpers.js';
import { AssetPipeline } from '../orchestration/AssetPipeline.js';

export function registerAssetTools(server: McpServer): void {
  server.registerTool(
    'godcp_list_assets',
    {
      title: 'List registered assets',
      description: 'List reusable assets in the GODCP registry (Meshy-generated models with local paths, hashes, tags, categories). Supports substring filtering.',
      inputSchema: {
        query: z.string().optional().describe('Substring match against id/description/tags/category.'),
        category: z.string().optional().describe('Filter by category (building, vegetation, vehicle, prop...).'),
        limit: z.number().int().min(1).max(500).optional().describe('Max entries (default 100).'),
      },
    },
    async ({ query, category, limit }) =>
      run('registry', async () => {
        const ctx = getAppContext();
        const all = await ctx.registry.list();
        const q = query?.toLowerCase();
        const filtered = all
          .filter((e) => (!category || e.category === category))
          .filter((e) => !q || `${e.id} ${e.description} ${(e.tags ?? []).join(' ')}`.toLowerCase().includes(q))
          .slice(0, limit ?? 100);
        return { total: all.length, returned: filtered.length, assets: filtered };
      }),
  );

  server.registerTool(
    'godcp_registry_stats',
    {
      title: 'Asset registry statistics',
      description: 'Return registry entry count plus current Meshy provider usage counters (API calls, generations started, credits spent).',
      inputSchema: {},
    },
    async () =>
      run('registry', async () => {
        const ctx = getAppContext();
        return {
          registry: { entries: await ctx.registry.count() },
          meshy: ctx.meshy.stats(),
          configured: { meshy: ctx.config.meshy.configured, vision: ctx.config.vision.provider, unityProfile: ctx.config.unity.profile },
          budget: ctx.config.budget,
        };
      }),
  );

  server.registerTool(
    'godcp_generate_assets',
    {
      title: 'Generate manifest assets via Meshy',
      description:
        'Resolve the stored AssetManifest: reuse registry matches and cache first, then generate only missing Meshy assets (budgeted), download GLB/OBJ, and register them. Returns generated/reused/skipped lists and credits spent.',
      inputSchema: {
        project: z.string().describe('Project slug with a stored asset manifest.'),
        dryRun: z.boolean().optional().describe('Report what would be generated without API calls.'),
        maxGenerations: z.number().int().min(0).optional().describe('Override Meshy generation budget for this call.'),
        approve: z.boolean().optional().describe('If true, auto-approve pending generations when approval mode is on (equivalent to GODCP_APPROVE_ALL=1 for this call).'),
      },
    },
    async ({ project, dryRun, maxGenerations, approve }) =>
      run('asset_generation', async () => {
        const ctx = getAppContext();
        const state = projectState(ctx, project);
        const manifest = await state.loadManifest();
        if (!manifest) {
          const { GODCPError } = await import('../utils/errors.js');
          throw new GODCPError('MANIFEST_MISSING', `No asset manifest for project "${project}". Run godcp_create_asset_manifest first.`, { stage: 'manifest' });
        }

        if (!dryRun && !ctx.meshy.isConfigured()) {
          const { GODCPError } = await import('../utils/errors.js');
          throw new GODCPError('MESHY_NOT_CONFIGURED', 'MESHY_API_KEY not set � cannot generate. Pass dryRun:true to preview.', { stage: 'asset_generation' });
        }
        const buildState = await state.loadState();
        const pipeline = new AssetPipeline({
          registry: ctx.registry,
          provider: ctx.meshy,
          budget: {
            ...ctx.config.budget,
            dryRun: dryRun ?? ctx.config.budget.dryRun,
            maxMeshyGenerations: maxGenerations ?? ctx.config.budget.maxMeshyGenerations,
          },
          outputDir: `${ctx.config.paths.assetDir}/${state.project}`,
          approvalFn: approve ? async () => true : undefined,
          logger: ctx.logger.scope('AssetPipeline'),
        });

        const result = await pipeline.resolve(manifest, {
          meshyGenerationsUsed: buildState?.meshyGenerationsUsed,
          meshyCallCount: buildState?.meshyCallCount,
        });

        if (buildState) {
          await state.saveState({
            ...buildState,
            meshyGenerationsUsed: result.meshyGenerationsUsed,
            meshyCallCount: result.meshyCallCount,
            assetsGenerated: buildState.assetsGenerated + result.generated.length,
            assetsReused: buildState.assetsReused + result.reused.length,
          });
        }

        return {
          project: state.project,
          generated: result.generated.map((g) => ({ assetId: g.assetId, primaryFile: g.primaryFile, source: g.source, credits: g.metadata.consumedCredits })),
          reused: result.reused,
          skipped: result.skipped,
          proceduralCount: result.proceduralCount,
          primitiveCount: result.primitiveCount,
          creditsSpent: result.creditsSpent,
          meshyGenerationsUsed: result.meshyGenerationsUsed,
          warnings: result.warnings,
        };
      }),
  );
}
