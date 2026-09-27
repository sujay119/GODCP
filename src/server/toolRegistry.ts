import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReferenceTools } from './referenceTools.js';
import { registerPlanningTools } from './planningTools.js';
import { registerAssetTools } from './assetTools.js';
import { registerEnvironmentTools } from './environmentTools.js';
import { registerUnityTools } from './unityTools.js';

export const TOOL_NAMES = [
  'godcp_analyze_reference',
  'godcp_compare_images',
  'godcp_create_scene_plan',
  'godcp_create_asset_manifest',
  'godcp_get_build_status',
  'godcp_build_environment_from_reference',
  'godcp_get_build_report',
  'godcp_list_assets',
  'godcp_registry_stats',
  'godcp_generate_assets',
  'godcp_capture_render',
  'godcp_get_scene_hierarchy',
  'godcp_unity_status',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Register every GODCP tool on the server. */
export function registerAllTools(server: McpServer): void {
  registerReferenceTools(server);
  registerPlanningTools(server);
  registerAssetTools(server);
  registerEnvironmentTools(server);
  registerUnityTools(server);
}
