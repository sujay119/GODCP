import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import type { Vec3 } from '../models/SceneObject.js';
import {
  joinPath,
  type CameraSpec,
  type GameObjectInfo,
  type LightSpec,
  type MaterialSpecInput,
  type PrimitiveKind,
  type RenderSettingsSpec,
  type TransformSpec,
  type UnityHierarchyNode,
  type UnityProvider,
} from './UnityProvider.js';

interface MockNode {
  name: string;
  path: string;
  kind: 'empty' | 'primitive' | 'light' | 'camera' | 'asset' | 'root';
  primitive?: PrimitiveKind;
  transform: Required<TransformSpec> & { position: Vec3; rotation: Vec3; scale: Vec3 };
  material?: MaterialSpecInput;
  parent?: string;
  children: string[];
}

export interface MockOperation {
  op: string;
  args: Record<string, unknown>;
  at: string;
}

/**
 * In-memory UnityProvider used by tests and the demo pipeline. It records every
 * operation, simulates a scene hierarchy, and "renders" a synthetic PNG whose
 * appearance actually depends on lighting/materials/placement — so the
 * comparison loop behaves realistically without a live Unity Editor.
 */
export class MockUnityProvider implements UnityProvider {
  readonly providerId = 'mock';
  readonly operations: MockOperation[] = [];

  private nodes = new Map<string, MockNode>();
  private camera?: CameraSpec;
  private lights: LightSpec[] = [];
  private renderSettings: RenderSettingsSpec = {};
  private sceneName = 'Untitled';
  private unityProjectRoot?: string;
  private connected = false;
  private screenshotCounter = 0;

  constructor(options: { unityProjectRoot?: string } = {}) {
    this.unityProjectRoot = options.unityProjectRoot;
    this.reset();
  }

  reset(): void {
    this.nodes.clear();
    this.camera = undefined;
    this.lights = [];
    this.renderSettings = { ambientColorHex: '#8899aa', ambientIntensity: 0.6 };
    this.sceneName = 'Untitled';
    this.nodes.set('', { name: '', path: '', kind: 'root', transform: zeroTransform(), children: [] });
  }

  private record(op: string, args: Record<string, unknown>): void {
    this.operations.push({ op, args, at: new Date().toISOString() });
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listAvailableTools(): Promise<string[]> {
    return [];
  }

  // ── Scene ───────────────────────────────────────────────────────────────

  async createScene(name: string): Promise<void> {
    this.record('scene.create', { name });
    this.reset();
    this.sceneName = name;
  }

  async openScene(name: string): Promise<void> {
    this.record('scene.open', { name });
    this.reset();
    this.sceneName = name;
  }

  async saveScene(): Promise<void> {
    this.record('scene.save', { name: this.sceneName });
  }

  async getHierarchy(): Promise<UnityHierarchyNode[]> {
    this.record('scene.hierarchy', {});
    const build = (path: string): UnityHierarchyNode => {
      const node = this.nodes.get(path)!;
      return {
        name: node.name || node.path,
        path: node.path,
        children: node.children.map(build),
      };
    };
    return build('').children;
  }

  get scene(): string {
    return this.sceneName;
  }

  // ── GameObjects ─────────────────────────────────────────────────────────

  async createEmpty(path: string): Promise<void> {
    this.record('object.createEmpty', { path });
    this.addNode({ path, kind: 'empty' });
  }

  async createPrimitive(kind: PrimitiveKind, path: string, transform: TransformSpec): Promise<void> {
    this.record('object.primitive', { kind, path, transform });
    this.addNode({ path, kind: 'primitive', primitive: kind, transform });
  }

  async setTransform(path: string, transform: TransformSpec): Promise<void> {
    this.record('object.transform', { path, transform });
    const node = this.require(path);
    node.transform = mergeTransform(node.transform, transform);
  }

  async duplicate(path: string, newPath: string): Promise<void> {
    this.record('object.duplicate', { path, newPath });
    const src = this.require(path);
    this.addNode({ path: newPath, kind: src.kind, primitive: src.primitive, transform: { ...src.transform }, material: src.material ? { ...src.material } : undefined });
  }

  async delete(path: string): Promise<void> {
    this.record('object.delete', { path });
    const node = this.nodes.get(path);
    if (!node) return;
    for (const child of [...node.children]) await this.delete(child);
    this.detach(path);
    this.nodes.delete(path);
  }

  async setParent(childPath: string, parentPath: string): Promise<void> {
    this.record('object.parent', { childPath, parentPath });
    const child = this.require(childPath);
    const parent = this.require(parentPath);
    this.detach(childPath);
    child.parent = parentPath;
    parent.children.push(childPath);
  }

  async inspectObject(path: string): Promise<GameObjectInfo | null> {
    this.record('object.inspect', { path });
    const node = this.nodes.get(path);
    if (!node) return null;
    return {
      name: node.name,
      path: node.path,
      active: true,
      transform: { position: node.transform.position, rotation: node.transform.rotation, scale: node.transform.scale },
      components: node.kind === 'primitive' ? ['MeshRenderer', 'MeshFilter', 'BoxCollider'] : node.kind === 'light' ? ['Light'] : [],
      children: node.children.length,
    };
  }

  // ── Assets ──────────────────────────────────────────────────────────────

  async importAsset(sourceFile: string, destUnityPath: string): Promise<string> {
    this.record('asset.import', { sourceFile, destUnityPath });
    this.addNode({ path: destUnityPath, kind: 'asset', transform: zeroTransform() });
    return destUnityPath;
  }

  async createPrefab(sourceObjectPath: string, prefabUnityPath: string): Promise<string> {
    this.record('asset.prefab', { sourceObjectPath, prefabUnityPath });
    this.addNode({ path: prefabUnityPath, kind: 'asset', transform: zeroTransform() });
    return prefabUnityPath;
  }

  async instantiate(assetUnityPath: string, instanceName: string, transform: TransformSpec, parentPath = ''): Promise<string> {
    this.record('asset.instantiate', { assetUnityPath, instanceName, transform, parentPath });
    const parent = this.require(parentPath);
    const path = joinPath(parentPath, instanceName);
    this.addNode({ path, kind: 'asset', transform, parent: parentPath });
    // reference the asset kind so render can color it
    const node = this.nodes.get(path)!;
    node.material = { name: assetUnityPath };
    parent.children.push(path);
    return path;
  }

  // ── Materials / lights / camera ─────────────────────────────────────────

  async setMaterial(targetPath: string, material: MaterialSpecInput): Promise<void> {
    this.record('material.set', { targetPath, material });
    const node = this.require(targetPath);
    node.material = { ...(node.material ?? {}), ...material };
  }

  async createLight(spec: LightSpec): Promise<void> {
    this.record('light.create', spec as unknown as Record<string, unknown>);
    const path = joinPath('', spec.name);
    this.addNode({ path, kind: 'light', transform: spec.transform });
    this.lights = [...this.lights.filter((l) => l.name !== spec.name), spec];
  }

  async configureCamera(spec: CameraSpec): Promise<void> {
    this.record('camera.configure', spec as unknown as Record<string, unknown>);
    this.camera = spec;
    const path = joinPath('', spec.name);
    if (!this.nodes.has(path)) this.addNode({ path, kind: 'camera', transform: { position: spec.position } });
  }

  async setRenderSettings(settings: RenderSettingsSpec): Promise<void> {
    this.record('render.settings', settings as unknown as Record<string, unknown>);
    this.renderSettings = { ...this.renderSettings, ...settings };
  }

  // ── Rendering (synthetic) ───────────────────────────────────────────────

  async captureScreenshot(destAbsPath: string): Promise<string> {
    this.screenshotCounter++;
    this.record('render.screenshot', { destAbsPath });
    const png = this.renderSynthetic();
    await mkdir(dirname(destAbsPath), { recursive: true });
    await writeFile(destAbsPath, PNG.sync.write(png));
    return destAbsPath;
  }

  get unityProjectPath(): string | undefined {
    return this.unityProjectRoot;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private addNode(input: {
    path: string;
    kind: MockNode['kind'];
    primitive?: PrimitiveKind;
    transform?: TransformSpec;
    material?: MaterialSpecInput;
    parent?: string;
  }): void {
    const name = input.path.split('/').filter(Boolean).pop() ?? input.path;
    const parentPath = input.parent ?? input.path.split('/').slice(0, -1).join('/');
    const parent = this.nodes.get(parentPath);
    const node: MockNode = {
      name,
      path: input.path,
      kind: input.kind,
      primitive: input.primitive,
      transform: mergeTransform(zeroTransform(), input.transform ?? {}),
      material: input.material,
      parent: parentPath,
      children: [],
    };
    this.nodes.set(input.path, node);
    if (parent && !parent.children.includes(input.path)) parent.children.push(input.path);
  }

  private require(path: string): MockNode {
    const node = this.nodes.get(path);
    if (!node) {
      // auto-create roots to keep the mock forgiving
      this.addNode({ path, kind: 'empty' });
      return this.nodes.get(path)!;
    }
    return node;
  }

  private detach(path: string): void {
    const node = this.nodes.get(path);
    if (node?.parent !== undefined) {
      const parent = this.nodes.get(node.parent);
      if (parent) parent.children = parent.children.filter((c) => c !== path);
    }
  }

  private renderSynthetic(): PNG {
    const width = 640;
    const height = 360;
    const png = new PNG({ width, height });

    const sun = this.lights.find((l) => l.type === 'directional') ?? this.lights[0];
    const sunIntensity = sun?.intensity ?? 1.1;
    const sunColor = hexToRgb(sun?.colorHex ?? '#fff4e0');
    const ambient = hexToRgb(this.renderSettings.ambientColorHex ?? '#8899aa');
    const ambientIntensity = this.renderSettings.ambientIntensity ?? 0.6;
    const fog = this.renderSettings.fog ? hexToRgb(this.renderSettings.fogColorHex ?? '#c9d6e3') : undefined;

    // Sky/ground background
    for (let y = 0; y < height; y++) {
      const t = y / height;
      const sky = { r: 120, g: 160, b: 210 };
      const ground = { r: 90, g: 92, b: 88 };
      const base = t < 0.55 ? sky : mix(sky, ground, (t - 0.55) / 0.45);
      const lit = applyLight(base, sunColor, sunIntensity, ambient, ambientIntensity);
      const color = fog ? mix(lit, fog, t * (this.renderSettings.fog ? 0.35 : 0)) : lit;
      for (let x = 0; x < width; x++) {
        const idx = (width * y + x) << 2;
        png.data[idx] = clamp8(color.r);
        png.data[idx + 1] = clamp8(color.g);
        png.data[idx + 2] = clamp8(color.b);
        png.data[idx + 3] = 255;
      }
    }

    // Project objects with a crude pinhole camera
    const cam = this.camera ?? { name: 'cam', position: { x: 0, y: 5, z: -12 }, fov: 50 };
    const focal = (width / 2) / Math.tan(((cam.fov ?? 50) * Math.PI) / 360);

    const drawables = [...this.nodes.values()]
      .filter((n) => n.kind === 'primitive' || n.kind === 'asset')
      .map((n) => ({ node: n, depth: cam.position.z - n.transform.position.z }))
      .filter((d) => d.depth > 0.5)
      .sort((a, b) => b.depth - a.depth);

    for (const { node, depth } of drawables) {
      const relX = node.transform.position.x - cam.position.x;
      const relY = node.transform.position.y - cam.position.y;
      const sx = width / 2 + (relX * focal) / depth;
      const sy = height / 2 - (relY * focal) / depth;
      const sizeX = Math.max(4, ((node.transform.scale.x * 0.9) * focal) / depth);
      const sizeY = Math.max(4, ((node.transform.scale.y * 0.9) * focal) / depth);

      const baseColor = node.material?.colorHex ? hexToRgb(node.material.colorHex) : defaultColorFor(node);
      const lit = applyLight(baseColor, sunColor, sunIntensity, ambient, ambientIntensity);
      const color = fog ? mix(lit, fog, Math.min(0.6, 1 / depth)) : lit;

      const x0 = Math.max(0, Math.round(sx - sizeX / 2));
      const x1 = Math.min(width - 1, Math.round(sx + sizeX / 2));
      const y0 = Math.max(0, Math.round(sy - sizeY / 2));
      const y1 = Math.min(height - 1, Math.round(sy + sizeY / 2));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const idx = (width * y + x) << 2;
          png.data[idx] = clamp8(color.r);
          png.data[idx + 1] = clamp8(color.g);
          png.data[idx + 2] = clamp8(color.b);
          png.data[idx + 3] = 255;
        }
      }
    }

    return png;
  }
}

function zeroTransform(): Required<TransformSpec> & { position: Vec3; rotation: Vec3; scale: Vec3 } {
  return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, parentPath: undefined as unknown as string };
}

function mergeTransform(
  base: Required<TransformSpec> & { position: Vec3; rotation: Vec3; scale: Vec3 },
  next: TransformSpec,
): Required<TransformSpec> & { position: Vec3; rotation: Vec3; scale: Vec3 } {
  return {
    position: next.position ? { ...next.position } : base.position,
    rotation: next.rotation ? { ...next.rotation } : base.rotation,
    scale: next.scale ? { ...next.scale } : base.scale,
    parentPath: next.parentPath ?? base.parentPath,
  };
}

function defaultColorFor(node: MockNode): { r: number; g: number; b: number } {
  if (node.primitive === 'sphere') return { r: 180, g: 180, b: 185 };
  if (node.primitive === 'cylinder') return { r: 70, g: 72, b: 78 };
  if (node.primitive === 'plane') return { r: 96, g: 110, b: 82 };
  const name = node.name.toLowerCase();
  if (name.includes('tree') || name.includes('vegetation')) return { r: 58, g: 110, b: 60 };
  if (name.includes('building')) return { r: 150, g: 140, b: 130 };
  if (name.includes('road') || name.includes('street')) return { r: 70, g: 70, b: 74 };
  if (name.includes('car') || name.includes('vehicle')) return { r: 160, g: 60, b: 55 };
  return { r: 140, g: 138, b: 134 };
}

function hexToRgb(hex: string | undefined): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return { r: 255, g: 255, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function applyLight(
  base: { r: number; g: number; b: number },
  sunColor: { r: number; g: number; b: number },
  sunIntensity: number,
  ambient: { r: number; g: number; b: number },
  ambientIntensity: number,
): { r: number; g: number; b: number } {
  const s = Math.min(2, sunIntensity) * 0.55;
  const a = Math.min(2, ambientIntensity) * 0.5;
  return {
    r: base.r * (s * (sunColor.r / 255) + a * (ambient.r / 255)),
    g: base.g * (s * (sunColor.g / 255) + a * (ambient.g / 255)),
    b: base.b * (s * (sunColor.b / 255) + a * (ambient.b / 255)),
  };
}

function mix(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number): { r: number; g: number; b: number } {
  const k = Math.max(0, Math.min(1, t));
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
