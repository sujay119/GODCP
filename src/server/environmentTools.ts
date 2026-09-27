import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAppContext, projectState, buildEnvironment,  } from './context.js';
import { run } from './toolHelpers.js';

export function registerEnvironmentTools(server: McpServer): void {
  server.registerTool(
    'godcp_build_environment_from_reference',
    {
      title: 'Build environment from reference image',
      description:
        'The full GODCP pipeline: validate reference → analyze image → scene plan → asset manifest → reuse/registry → Meshy 3D generation (budgeted) → Unity scene construction (via Unity MCP) → render → visual comparison → iterative correction → BuildReport. Resumable; returns a structured BuildReport. Set GODCP_DRY_RUN=1 to plan without spending Meshy credits.',
      inputSchema: {
        referenceImage: z.string().describe('Path to the reference environment image (PNG preferred).'),
        unityProject: z.string().optional().describe('Unity project root path (Assets/ folder parent).'),
        sceneName: z.string().optional().describe('Unity scene name (default GeneratedEnvironment).'),
        project: z.string().optional().describe('Project slug for state (default derived from sceneName).'),
        style: z.string().optional().describe('Target style hint fed to planning (e.g. "photorealistic urban street").'),
        maxIterations: z.number().int().min(1).max(10).optional().describe('Render/compare/correct loop cap (default from GODCP_MAX_ITERATIONS).'),
        maxMeshyGenerations: z.number().int().min(0).optional().describe('Override Meshy generation budget for this call.'),
        assetQuality: z.enum(['draft', 'standard', 'high']).optional().describe('Asset quality tier (maps to Meshy preview/refine).'),
        dryRun: z.boolean().optional().describe('Plan only: no Meshy generation, no Unity writes.'),
        resume: z.boolean().optional().describe('Resume from persisted state (default true). Pass false to force a fresh build.'),
      },
    },
    async (args) =>
      run('build', async () => {
        const ctx = getAppContext();
        const report = await buildEnvironment(ctx, {
          referenceImage: args.referenceImage,
          unityProject: args.unityProject,
          sceneName: args.sceneName,
          project: args.project,
          style: args.style,
          maxIterations: args.maxIterations,
          assetQuality: args.assetQuality,
          dryRun: args.dryRun,
          maxMeshyGenerations: args.maxMeshyGenerations,
          resume: args.resume,
        });
        return report;
      }),
  );

  server.registerTool(
    'godcp_get_build_report',
    {
      title: 'Get build report',
      description: 'Return the persisted BuildReport for a project (status, credits, iterations, final similarity, warnings, error).',
      inputSchema: { project: z.string().describe('Project slug.') },
    },
    async ({ project }) =>
      run('state', async () => {
        const ctx = getAppContext();
        const state = projectState(ctx, project);
        const report = await state.loadReport();
        if (!report) {
          const { GODCPError } = await import('../utils/errors.js');
          throw new GODCPError('REPORT_MISSING', `No report for project "${project}". Build may not have run yet.`, { stage: 'state' });
        }
        return report;
      }),
  );
}
