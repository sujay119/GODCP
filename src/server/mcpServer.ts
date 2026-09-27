import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAppContext } from './context.js';
import { registerAllTools } from './toolRegistry.js';

export const SERVER_VERSION = '0.1.0';

/** Build a fully-configured MCP server exposing all GODCP tools. */
export function createMcpServer(): McpServer {
  const ctx = getAppContext();
  const server = new McpServer(
    {
      name: 'godcp',
      version: SERVER_VERSION,
    },
    {
      instructions: [
        'GODCP MCP: turn a reference environment image into a game-ready 3D scene.',
        'Typical flow: godcp_build_environment_from_reference (full pipeline), or stepwise:',
        '  1) godcp_analyze_reference → 2) godcp_create_scene_plan → 3) godcp_create_asset_manifest →',
        '  4) godcp_generate_assets → 5) godcp_capture_render → 6) godcp_compare_images → godcp_get_build_status.',
        `Config: vision=${ctx.config.vision.provider}, unity=${ctx.config.unity.profile}, meshy=${ctx.config.meshy.configured ? 'configured' : 'NOT configured'}.`,
        'All tools return structured JSON; errors use the GODCP error envelope {success:false, stage, errorCode, message, retryable}.',
      ].join(' '),
    },
  );
  registerAllTools(server);
  return server;
}
