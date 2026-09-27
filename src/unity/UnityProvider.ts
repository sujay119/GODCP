import type { Vec3 } from '../models/SceneObject.js';

export interface TransformSpec {
  position?: Vec3;
  /** Euler angles in degrees. */
  rotation?: Vec3;
  scale?: Vec3;
  parentPath?: string;
}

export interface UnityHierarchyNode {
  name: string;
  path: string;
  children: UnityHierarchyNode[];
}

export interface GameObjectInfo {
  name: string;
  path: string;
  active?: boolean;
  tag?: string;
  layer?: number;
  transform?: { position?: Vec3; rotation?: Vec3; scale?: Vec3 };
  components?: string[];
  children?: number;
}

export type PrimitiveKind = 'cube' | 'sphere' | 'cylinder' | 'plane' | 'capsule';

export interface LightSpec {
  name: string;
  type: 'directional' | 'point' | 'spot';
  transform: TransformSpec;
  colorHex?: string;
  intensity?: number;
  shadows?: boolean;
}

export interface CameraSpec {
  name: string;
  position: Vec3;
  lookAt?: Vec3;
  direction?: Vec3;
  fov?: number;
  near?: number;
  far?: number;
}

export interface MaterialSpecInput {
  colorHex?: string;
  /** Unity project-relative texture path (Assets/...). */
  texturePath?: string;
  name?: string;
  metallic?: number;
  roughness?: number;
}

export interface RenderSettingsSpec {
  ambientColorHex?: string;
  ambientIntensity?: number;
  fog?: boolean;
  fogColorHex?: string;
  fogDensity?: number;
}

/**
 * Semantic Unity operations. All Unity MCP implementations sit behind this
 * interface — orchestration never sees Unity tool names or payloads.
 */
export interface UnityProvider {
  readonly providerId: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Cheap availability probe (also used by `godcp doctor`). */
  isAvailable(): Promise<boolean>;
  /** Names of tools discovered from the Unity MCP server (empty for mock). */
  listAvailableTools(): Promise<string[]>;

  // Scene
  createScene(name: string): Promise<void>;
  openScene(name: string): Promise<void>;
  saveScene(): Promise<void>;
  getHierarchy(): Promise<UnityHierarchyNode[]>;

  // GameObjects
  createEmpty(path: string): Promise<void>;
  createPrimitive(kind: PrimitiveKind, path: string, transform: TransformSpec): Promise<void>;
  setTransform(path: string, transform: TransformSpec): Promise<void>;
  duplicate(path: string, newPath: string): Promise<void>;
  delete(path: string): Promise<void>;
  setParent(childPath: string, parentPath: string): Promise<void>;
  inspectObject(path: string): Promise<GameObjectInfo | null>;

  // Assets
  /** Copy a local file into the Unity project and return its Unity path (Assets/...). */
  importAsset(sourceFile: string, destUnityPath: string): Promise<string>;
  createPrefab(sourceObjectPath: string, prefabUnityPath: string): Promise<string>;
  instantiate(assetUnityPath: string, instanceName: string, transform: TransformSpec, parentPath?: string): Promise<string>;

  // Materials / lights / camera / render settings
  setMaterial(targetPath: string, material: MaterialSpecInput): Promise<void>;
  createLight(spec: LightSpec): Promise<void>;
  configureCamera(spec: CameraSpec): Promise<void>;
  setRenderSettings(settings: RenderSettingsSpec): Promise<void>;

  // Rendering
  captureScreenshot(destAbsPath: string): Promise<string>;
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}
