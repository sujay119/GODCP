/**
 * Unity tool-mapping profiles.
 *
 * Unity MCP is not a single standard: tool names and argument shapes differ
 * between implementations (MCP for Unity, Unity official relay, in-editor HTTP
 * servers). GODCP therefore maps semantic operations → candidate tool calls
 * through profiles, resolved at runtime against `tools/list` discovery, with a
 * schema-driven argument adapter and fuzzy-name fallback. Nothing about Unity
 * tool naming is hard-coded into the orchestration layer.
 */

export type SemanticOp =
  | 'scene.create'
  | 'scene.open'
  | 'scene.save'
  | 'scene.hierarchy'
  | 'object.createEmpty'
  | 'object.primitive'
  | 'object.transform'
  | 'object.duplicate'
  | 'object.delete'
  | 'object.parent'
  | 'object.inspect'
  | 'asset.import'
  | 'asset.prefab'
  | 'asset.instantiate'
  | 'material.set'
  | 'light.create'
  | 'camera.configure'
  | 'render.settings'
  | 'render.screenshot';

export const SEMANTIC_OPS: SemanticOp[] = [
  'scene.create',
  'scene.open',
  'scene.save',
  'scene.hierarchy',
  'object.createEmpty',
  'object.primitive',
  'object.transform',
  'object.duplicate',
  'object.delete',
  'object.parent',
  'object.inspect',
  'asset.import',
  'asset.prefab',
  'asset.instantiate',
  'material.set',
  'light.create',
  'camera.configure',
  'render.settings',
  'render.screenshot',
];

export interface ToolCandidate {
  /** Exact tool name as advertised by the Unity MCP server (optional). */
  tool?: string;
  /** Intended action/operation discriminator value for action-style tools. */
  action?: string;
  /** Static extra arguments merged into the call. */
  args?: Record<string, unknown>;
}

export type MappingProfile = Record<SemanticOp, ToolCandidate[]>;

export type ProfileId = 'mcpforunity' | 'unity-official' | 'generic';

// ── MCP for Unity (CoplayDev/unity-mcp) ───────────────────────────────────

const mcpforunity: MappingProfile = {
  'scene.create': [{ tool: 'manage_scene', action: 'create', args: { template: '3d_basic' } }],
  'scene.open': [{ tool: 'manage_scene', action: 'load' }],
  'scene.save': [{ tool: 'manage_scene', action: 'save' }],
  'scene.hierarchy': [{ tool: 'manage_scene', action: 'get_hierarchy' }, { tool: 'find_gameobjects', action: 'list' }],
  'object.createEmpty': [{ tool: 'manage_gameobject', action: 'create' }],
  'object.primitive': [{ tool: 'manage_gameobject', action: 'create', args: { isPrimitive: true } }],
  'object.transform': [{ tool: 'manage_gameobject', action: 'set_transform' }, { tool: 'manage_gameobject', action: 'modify' }],
  'object.duplicate': [{ tool: 'manage_gameobject', action: 'duplicate' }],
  'object.delete': [{ tool: 'manage_gameobject', action: 'delete' }],
  'object.parent': [{ tool: 'manage_gameobject', action: 'set_parent' }, { tool: 'manage_gameobject', action: 'reparent' }],
  'object.inspect': [{ tool: 'manage_gameobject', action: 'get' }, { tool: 'find_gameobjects', action: 'find' }],
  'asset.import': [{ tool: 'manage_asset', action: 'import' }],
  'asset.prefab': [{ tool: 'manage_prefabs', action: 'create' }],
  'asset.instantiate': [{ tool: 'manage_prefabs', action: 'instantiate' }, { tool: 'manage_gameobject', action: 'instantiate' }],
  'material.set': [{ tool: 'manage_material', action: 'set' }, { tool: 'manage_material', action: 'create' }],
  'light.create': [{ tool: 'manage_gameobject', action: 'create', args: { component: 'Light' } }],
  'camera.configure': [{ tool: 'manage_camera', action: 'configure' }, { tool: 'manage_camera', action: 'set' }],
  'render.settings': [{ tool: 'manage_scene', action: 'set_render_settings' }, { tool: 'manage_graphics', action: 'set_render_settings' }],
  'render.screenshot': [{ tool: 'manage_camera', action: 'capture_screenshot' }, { tool: 'manage_camera', action: 'screenshot' }],
};

// ── Unity official AI Assistant MCP (relay) ───────────────────────────────

const unityOfficial: MappingProfile = {
  'scene.create': [{ tool: 'Unity.ManageScene', action: 'Create' }],
  'scene.open': [{ tool: 'Unity.ManageScene', action: 'Load' }],
  'scene.save': [{ tool: 'Unity.ManageScene', action: 'Save' }],
  'scene.hierarchy': [{ tool: 'Unity.ManageScene', action: 'GetHierarchy' }],
  'object.createEmpty': [{ tool: 'Unity.ManageGameObject', action: 'Create' }],
  'object.primitive': [{ tool: 'Unity.ManageGameObject', action: 'Create' }],
  'object.transform': [{ tool: 'Unity.ManageGameObject', action: 'SetTransform' }, { tool: 'Unity.ManageGameObject', action: 'Modify' }],
  'object.duplicate': [{ tool: 'Unity.ManageGameObject', action: 'Duplicate' }],
  'object.delete': [{ tool: 'Unity.ManageGameObject', action: 'Delete' }],
  'object.parent': [{ tool: 'Unity.ManageGameObject', action: 'SetParent' }],
  'object.inspect': [{ tool: 'Unity.ManageGameObject', action: 'Get' }, { tool: 'Unity.ManageGameObject', action: 'Inspect' }],
  'asset.import': [{ tool: 'Unity.ImportExternalModel' }, { tool: 'Unity.ManageAsset', action: 'Import' }],
  'asset.prefab': [{ tool: 'Unity.ManagePrefab', action: 'Create' }],
  'asset.instantiate': [{ tool: 'Unity.ManageGameObject', action: 'Instantiate' }, { tool: 'Unity.ManagePrefab', action: 'Instantiate' }],
  'material.set': [{ tool: 'Unity.ManageMaterial', action: 'Set' }, { tool: 'Unity.ManageGameObject', action: 'SetComponentProperty' }],
  'light.create': [{ tool: 'Unity.ManageGameObject', action: 'Create', args: { component: 'Light' } }],
  'camera.configure': [{ tool: 'Unity.ManageCamera', action: 'Configure' }],
  'render.settings': [{ tool: 'Unity.ManageScene', action: 'SetRenderSettings' }],
  'render.screenshot': [{ tool: 'Unity.CaptureScreenshot' }, { tool: 'Unity.ManageCamera', action: 'CaptureScreenshot' }],
};

// ── Generic (fuzzy-only) ──────────────────────────────────────────────────

const generic: MappingProfile = Object.fromEntries(
  SEMANTIC_OPS.map((op) => [op, [{} as ToolCandidate]]),
) as MappingProfile;

export const PROFILES: Record<ProfileId, MappingProfile> = {
  mcpforunity: mcpforunity,
  'unity-official': unityOfficial,
  generic,
};

/** Fuzzy hints: tokens used to match discovered tool names when profiles miss. */
export const FUZZY_HINTS: Record<SemanticOp, string[]> = {
  'scene.create': ['createscene', 'newscene', 'managescene'],
  'scene.open': ['loadscene', 'openscene', 'managescene'],
  'scene.save': ['savescene', 'managescene'],
  'scene.hierarchy': ['hierarchy', 'gethierarchy', 'scenehierarchy', 'scenestate', 'managescene'],
  'object.createEmpty': ['addgameobject', 'creategameobject', 'createempty', 'managegameobject'],
  'object.primitive': ['primitive', 'creategameobject', 'addgameobject', 'managegameobject'],
  'object.transform': ['transform', 'settransform', 'setfield', 'managegameobject'],
  'object.duplicate': ['duplicate', 'clone', 'managegameobject'],
  'object.delete': ['deletegameobject', 'removegameobject', 'managegameobject'],
  'object.parent': ['parent', 'reparent', 'managegameobject'],
  'object.inspect': ['inspect', 'getgameobject', 'readgameobject', 'findgameobjects', 'managegameobject'],
  'asset.import': ['import', 'importexternalmodel', 'manageasset'],
  'asset.prefab': ['prefab', 'manageprefabs'],
  'asset.instantiate': ['instantiate', 'spawn', 'createinstance', 'manageprefabs', 'managegameobject'],
  'material.set': ['material', 'managematerial', 'setcomponentproperty'],
  'light.create': ['light', 'createlight', 'managegameobject'],
  'camera.configure': ['camera', 'managecamera', 'configurecamera'],
  'render.settings': ['rendersettings', 'lighting', 'environment', 'graphics'],
  'render.screenshot': ['screenshot', 'capture', 'rendertexture', 'captureScreenshot'.toLowerCase()],
};

// ── Schema-driven argument adaptation ─────────────────────────────────────

type JsonSchema = Record<string, any>;

const OP_ARG_ALIASES: Record<string, string[]> = {
  targetPath: ['targetPath', 'path', 'target', 'objectPath', 'gameObjectPath', 'gameObjectName', 'name', 'object'],
  newPath: ['newPath', 'newName', 'duplicateName', 'destination'],
  sourceFile: ['sourceFile', 'source', 'filePath', 'src', 'file'],
  destUnityPath: ['destUnityPath', 'destination', 'dest', 'assetPath', 'targetPath', 'path'],
  assetPath: ['assetPath', 'path', 'prefabPath', 'source', 'asset'],
  prefabPath: ['prefabPath', 'destUnityPath', 'destination', 'path'],
  instanceName: ['instanceName', 'name', 'newName'],
  parentPath: ['parentPath', 'parent', 'parentName'],
  position: ['position', 'pos'],
  rotation: ['rotation', 'rot', 'eulerAngles'],
  scale: ['scale'],
  colorHex: ['colorHex', 'color', 'colour', 'tint'],
  intensity: ['intensity', 'lightIntensity'],
  texturePath: ['texturePath', 'texture'],
  sourceObjectPath: ['sourceObjectPath', 'source', 'path', 'objectPath'],
  sceneName: ['sceneName', 'name'],
  destAbsPath: ['destAbsPath', 'path', 'outputPath', 'filePath', 'dest'],
  primitiveKind: ['primitiveKind', 'primitive', 'primitiveType', 'shape', 'geometry'],
};

/** Find the value for `key` inside `opArgs`, honouring alias chains. */
function lookup(opArgs: Record<string, unknown>, key: string): unknown {
  if (key in opArgs && opArgs[key] !== undefined) return opArgs[key];
  const aliases = OP_ARG_ALIASES[key];
  if (aliases) {
    for (const alias of aliases) {
      if (alias in opArgs && opArgs[alias] !== undefined) return opArgs[alias];
    }
  }
  // last resort: any key case-insensitively equal
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(opArgs)) {
    if (k.toLowerCase() === lower && v !== undefined) return v;
  }
  return undefined;
}

function coerceToSchema(value: unknown, schema: JsonSchema): unknown {
  if (value === undefined || value === null) return value;
  const isArrayTarget = schema.type === 'array';
  const isVecObject =
    typeof value === 'object' && value !== null && ['x', 'y', 'z'].every((k) => k in (value as object));
  if (isArrayTarget && isVecObject) {
    const v = value as { x: number; y: number; z: number };
    return [v.x, v.y, v.z];
  }
  if (!isArrayTarget && Array.isArray(value) && schema.type === 'object') {
    const [x, y, z] = value as number[];
    return { x, y, z };
  }
  if (schema.type === 'number' && typeof value === 'string') {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  if (schema.type === 'string' && typeof value === 'string') return value;
  if (schema.enum && typeof value === 'string') {
    const match = pickFromEnum(schema.enum as string[], value);
    if (match !== undefined) return match;
    return undefined; // never send values the tool will reject
  }
  return value;
}

function pickFromEnum(values: string[], intended: string): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(intended);
  if (values.map(norm).includes(target)) return values.find((v) => norm(v) === target);
  // fuzzy: highest character-bigram overlap
  let best: string | undefined;
  let bestScore = 0;
  for (const v of values) {
    const score = similarity(norm(v), target);
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (s.length === 1) set.add(s);
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export interface BuiltToolCall {
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * Build the argument payload for `tool` from the tool's advertised input
 * schema + the semantic op arguments. Fills properties by name/alias, coerces
 * vectors to the schema shape, picks action/operation values from enums, and
 * never invents values that violate declared enums.
 */
export function buildToolArgs(
  tool: string,
  inputSchema: JsonSchema | undefined,
  opArgs: Record<string, unknown>,
  intendedAction?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props: Record<string, JsonSchema> = inputSchema?.properties ?? {};
  const hasSchema = Object.keys(props).length > 0;

  if (!hasSchema) {
    // No schema advertised: pass through the semantic args + action.
    Object.assign(out, opArgs);
    if (intendedAction !== undefined) out.action = intendedAction;
    return out;
  }

  for (const [propName, propSchema] of Object.entries(props)) {
    const lower = propName.toLowerCase();
    if (['action', 'operation', 'op', 'command', 'method'].includes(lower)) {
      const intended = intendedAction ?? (opArgs.action as string | undefined);
      if (intended) {
        const picked = propSchema.enum ? pickFromEnum(propSchema.enum as string[], intended) : intended;
        if (picked !== undefined) out[propName] = picked;
      }
      continue;
    }
    // find a value: direct key first, then aliases keyed by *our* arg names
    let value = opArgs[propName];
    if (value === undefined) {
      for (const [ourKey, aliases] of Object.entries(OP_ARG_ALIASES)) {
        if (aliases.includes(propName)) {
          value = lookup(opArgs, ourKey);
          if (value !== undefined) break;
        }
      }
    }
    if (value === undefined) value = lookup(opArgs, propName);
    if (value === undefined) continue;

    const coerced = coerceToSchema(value, propSchema);
    if (coerced !== undefined) out[propName] = coerced;
  }

  // Enum-guarded special case: `type`/`primitiveType` should only receive a
  // primitive name if the enum actually allows it (handled by coerce above).
  if (intendedAction !== undefined && out.action === undefined && 'action' in (inputSchema?.properties ?? {})) {
    out.action = intendedAction;
  }
  return out;
}

/** Resolve a semantic op to a concrete tool call against discovered tools. */
export function resolveToolCall(
  profile: MappingProfile,
  op: SemanticOp,
  discoveredTools: Map<string, JsonSchema | undefined>,
  opArgs: Record<string, unknown>,
): BuiltToolCall | undefined {
  const candidates = profile[op] ?? [];
  const available = [...discoveredTools.keys()];

  // 1) exact profile candidates
  for (const candidate of candidates) {
    if (candidate.tool && discoveredTools.has(candidate.tool)) {
      const schema = discoveredTools.get(candidate.tool);
      const args = buildToolArgs(candidate.tool, schema, { ...(candidate.args ?? {}), ...opArgs }, candidate.action);
      return { tool: candidate.tool, arguments: args };
    }
  }

  // 2) fuzzy match on discovered tool names
  const hints = FUZZY_HINTS[op] ?? [];
  let best: { tool: string; score: number } | undefined;
  for (const name of available) {
    const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let score = 0;
    for (const hint of hints) {
      const h = hint.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (norm.includes(h)) score = Math.max(score, h.length / Math.max(norm.length, 1) + 0.5);
      else score = Math.max(score, similarity(norm, h));
    }
    if (score > 0.45 && (!best || score > best.score)) best = { tool: name, score };
  }
  if (best) {
    const schema = discoveredTools.get(best.tool);
    const action = candidates.find((c) => c.action)?.action;
    const args = buildToolArgs(best.tool, schema, opArgs, action);
    return { tool: best.tool, arguments: args };
  }

  return undefined;
}

/** Load an optional user-provided profile override (JSON file). */
export function mergeProfileOverride(base: MappingProfile, override: Partial<MappingProfile>): MappingProfile {
  const merged: MappingProfile = { ...base };
  for (const [op, candidates] of Object.entries(override)) {
    if (Array.isArray(candidates)) {
      merged[op as SemanticOp] = candidates as MappingProfile[SemanticOp];
    }
  }
  return merged;
}
