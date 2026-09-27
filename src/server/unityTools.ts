import { z } from 'zod';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAppContext, renderer } from './context.js';
import { run } from './toolHelpers.js';

export function registerUnityTools(server: McpServer): void {
  server.registerTool(
    'godcp_capture_render',
    {
      title: 'Capture Unity render',
      description:
        'Ask Unity (via Unity MCP) to render the active camera view and save a PNG. Uses the mock provider (synthetic PNG) when Unity MCP is not configured. Returns the absolute render path.',
      inputSchema: {
        outputPath: z.string().optional().describe('Destination PNG path (default: assets/renders/manual-<ts>.png).'),
      },
    },
    async ({ outputPath }) =>
      run('render', async () => {
        const ctx = getAppContext();
        const dest = outputPath ?? join(ctx.config.paths.renderDir, `manual-${Date.now()}.png`);
        await mkdir(dirname(dest), { recursive: true });
        const path = await renderer(ctx).render(dest);
        return { renderPath: path, unityProfile: ctx.config.unity.profile };
      }),
  );

  server.registerTool(
    'godcp_get_scene_hierarchy',
    {
      title: 'Get Unity scene hierarchy',
      description: 'Return the current Unity scene hierarchy (via Unity MCP semantic tool) — useful to verify GODCP construction in the editor.',
      inputSchema: {},
    },
    async () =>
      run('unity', async () => {
        const ctx = getAppContext();
        await ctx.unity.connect().catch(() => undefined);
        const hierarchy = await ctx.unity.getHierarchy();
        return { unityProfile: ctx.config.unity.profile, hierarchy };
      }),
  );

  server.registerTool(
    'godcp_unity_status',
    {
      title: 'Unity connection status',
      description: 'Report whether a Unity MCP endpoint is configured/reachable and which mapping profile is in use.',
      inputSchema: {},
    },
    async () =>
      run('unity', async () => {
        const ctx = getAppContext();
        const available = await ctx.unity.isAvailable().catch(() => false);
        const tools = available ? await ctx.unity.listAvailableTools().catch(() => [] as string[]) : [];
        return {
          profile: ctx.config.unity.profile,
          url: ctx.config.unity.url,
          command: ctx.config.unity.command,
          projectPath: ctx.config.unity.projectPath,
          available,
          tools,
        };
      }),
  );
}
