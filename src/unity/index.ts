import { readFileSync } from 'node:fs';
import type { GODCPConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { UnityMcpClient } from './UnityMcpClient.js';
import { MockUnityProvider } from './MockUnityProvider.js';
import type { UnityProvider } from './UnityProvider.js';
import type { MappingProfile, ProfileId } from './toolMapping.js';

export * from './UnityProvider.js';
export * from './toolMapping.js';
export { UnityMcpClient } from './UnityMcpClient.js';
export { MockUnityProvider } from './MockUnityProvider.js';
export { UnitySceneManager } from './UnitySceneManager.js';
export { UnityGameObjectManager } from './UnityGameObjectManager.js';
export { UnityAssetImporter } from './UnityAssetImporter.js';
export { UnityMaterialManager } from './UnityMaterialManager.js';
export { UnityCameraManager } from './UnityCameraManager.js';
export { UnityRenderer } from './UnityRenderer.js';

/**
 * McpUnityProvider adapts the UnityProvider interface onto UnityMcpClient
 * (semantic op → profile → MCP tools/call).
 */
export class McpUnityProvider implements UnityProvider {
  readonly providerId: string;
  readonly client: UnityMcpClient;

  constructor(client: UnityMcpClient, profile: ProfileId) {
    this.client = client;
    this.providerId = `unity-mcp:${profile}`;
  }

  async connect(): Promise<void> { await this.client.connect(); }
  async disconnect(): Promise<void> { await this.client.disconnect(); }
  async isAvailable(): Promise<boolean> {
    try {
      await this.client.listTools();
      return true;
    } catch {
      return false;
    }
  }
  async listAvailableTools(): Promise<string[]> { return this.client.toolNames(); }

  async createScene(name: string): Promise<void> { await this.client.callSemantic('scene.create', { sceneName: name, name }); }
  async openScene(name: string): Promise<void> { await this.client.callSemantic('scene.open', { sceneName: name, name }); }
  async saveScene(): Promise<void> { await this.client.callSemantic('scene.save', {}); }
  async getHierarchy() {
    const res = await this.client.callSemantic('scene.hierarchy', {});
    return parseHierarchy(res.data ?? res.raw);
  }

  async createEmpty(path: string): Promise<void> {
    await this.client.callSemantic('object.createEmpty', { targetPath: path, name: lastSegment(path), parentPath: parentOf(path) });
  }

  async createPrimitive(kind: string, path: string, t: { position?: any; rotation?: any; scale?: any }): Promise<void> {
    await this.client.callSemantic('object.primitive', {
      primitiveKind: kind,
      targetPath: path,
      name: lastSegment(path),
      parentPath: parentOf(path),
      position: t.position,
      rotation: t.rotation,
      scale: t.scale ?? { x: 1, y: 1, z: 1 },
    });
  }

  async setTransform(path: string, t: { position?: any; rotation?: any; scale?: any; parentPath?: string }): Promise<void> {
    await this.client.callSemantic('object.transform', { targetPath: path, ...t });
  }

  async duplicate(path: string, newPath: string): Promise<void> {
    await this.client.callSemantic('object.duplicate', { targetPath: path, newPath, name: lastSegment(newPath) });
  }

  async delete(path: string): Promise<void> { await this.client.callSemantic('object.delete', { targetPath: path }); }

  async setParent(childPath: string, parentPath: string): Promise<void> {
    await this.client.callSemantic('object.parent', { targetPath: childPath, parentPath });
  }

  async inspectObject(path: string) {
    const res = await this.client.callSemantic('object.inspect', { targetPath: path });
    return parseObjectInfo(res.data ?? res.raw, path);
  }

  async importAsset(sourceFile: string, destUnityPath: string): Promise<string> {
    const res = await this.client.callSemantic('asset.import', { sourceFile, destUnityPath });
    return typeof res.data === 'string' ? res.data : destUnityPath;
  }

  async createPrefab(sourceObjectPath: string, prefabUnityPath: string): Promise<string> {
    const res = await this.client.callSemantic('asset.prefab', { sourceObjectPath, prefabPath: prefabUnityPath });
    return typeof res.data === 'string' ? res.data : prefabUnityPath;
  }

  async instantiate(assetUnityPath: string, instanceName: string, t: any, parentPath = ''): Promise<string> {
    const res = await this.client.callSemantic('asset.instantiate', {
      assetPath: assetUnityPath,
      instanceName,
      name: instanceName,
      parentPath,
      position: t.position,
      rotation: t.rotation,
      scale: t.scale,
    });
    return typeof res.data === 'string' ? res.data : instanceName;
  }

  async setMaterial(targetPath: string, material: any): Promise<void> {
    await this.client.callSemantic('material.set', { targetPath, ...material });
  }

  async createLight(spec: any): Promise<void> { await this.client.callSemantic('light.create', spec); }
  async configureCamera(spec: any): Promise<void> { await this.client.callSemantic('camera.configure', spec); }
  async setRenderSettings(settings: any): Promise<void> { await this.client.callSemantic('render.settings', settings); }

  async captureScreenshot(destAbsPath: string): Promise<string> {
    const res = await this.client.callSemantic('render.screenshot', { destAbsPath }, 60000);
    return typeof res.data === 'string' ? res.data : destAbsPath;
  }
}

function lastSegment(p: string): string { return p.split('/').filter(Boolean).pop() ?? p; }
function parentOf(p: string): string { return p.split('/').slice(0, -1).join('/'); }

function parseHierarchy(data: unknown): any[] {
  if (Array.isArray(data)) return data as any[];
  if (data && typeof data === 'object') {
    const d = data as any;
    if (Array.isArray(d.hierarchy)) return d.hierarchy;
    if (Array.isArray(d.data)) return d.data;
    if (Array.isArray(d.gameObjects)) return d.gameObjects;
  }
  if (typeof data === 'string') {
    try { return parseHierarchy(JSON.parse(data)); } catch { /* raw text */ }
  }
  return [];
}

function parseObjectInfo(data: unknown, path: string): any | null {
  if (!data) return null;
  if (typeof data === 'object') {
    const d = data as any;
    const obj = d.data && typeof d.data === 'object' ? d.data : d;
    return { name: obj.name ?? lastSegment(path), path, ...obj };
  }
  return null;
}

export interface CreateUnityProviderOptions {
  config: GODCPConfig;
  toolMapOverridePath?: string;
}

/** Factory: mock (default when nothing configured), or MCP-backed Unity. */
export function createUnityProvider(options: CreateUnityProviderOptions): UnityProvider {
  const { config } = options;
  const log = createLogger('Unity');

  if (config.unity.profile === 'mock' || (!config.unity.url && !config.unity.command)) {
    if (config.unity.profile !== 'mock') {
      log.warn('Unity MCP not configured — using MockUnityProvider (set UNITY_MCP_URL / UNITY_MCP_COMMAND for a real editor).');
    }
    return new MockUnityProvider({ unityProjectRoot: config.unity.projectPath });
  }

  let override: Partial<MappingProfile> | undefined;
  const overridePath = options.toolMapOverridePath ?? process.env.UNITY_MCP_TOOL_MAP;
  if (overridePath) {
    try {
      override = JSON.parse(readFileSync(overridePath, 'utf8')) as Partial<MappingProfile>;
    } catch (err) {
      log.warn('Failed to read UNITY_MCP_TOOL_MAP override — ignoring', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const client = new UnityMcpClient({
    url: config.unity.url,
    command: config.unity.command,
    profile: config.unity.profile,
    toolMapOverride: override,
    logger: log,
  });
  return new McpUnityProvider(client, config.unity.profile);
}
