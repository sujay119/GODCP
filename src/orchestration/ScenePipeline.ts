import { createLogger, type Logger } from '../utils/logger.js';
import { joinPath, type UnityProvider } from '../unity/UnityProvider.js';
import { UnitySceneManager } from '../unity/UnitySceneManager.js';
import { UnityGameObjectManager } from '../unity/UnityGameObjectManager.js';
import { UnityAssetImporter } from '../unity/UnityAssetImporter.js';
import { UnityMaterialManager } from '../unity/UnityMaterialManager.js';
import { UnityCameraManager } from '../unity/UnityCameraManager.js';
import type { ScenePlan, SceneObject, MaterialSpec } from '../models/ScenePlan.js';
import type { AssetManifest } from '../models/AssetSpec.js';

export interface ScenePipelineOptions {
  unity: UnityProvider;
  unityProjectPath?: string;
  logger?: Logger;
}

export interface SceneBuildResult {
  proceduralObjects: number;
  instantiatedAssets: number;
  primitivesCreated: number;
  objectsPlaced: number;
  warnings: string[];
}

const ROOT = 'GODCP';

/**
 * Applies a ScenePlan to Unity: scene lifecycle, procedural geometry,
 * asset instantiation, materials, lights, camera, render settings, save.
 * Idempotent-ish: after the first construction it switches to update mode
 * (setTransform instead of re-creating objects).
 */
export class ScenePipeline {
  readonly scene: UnitySceneManager;
  readonly objects: UnityGameObjectManager;
  readonly importer: UnityAssetImporter;
  readonly materials: UnityMaterialManager;
  readonly camera: UnityCameraManager;

  private readonly log: Logger;
  private constructed = false;

  constructor(private readonly options: ScenePipelineOptions) {
    const log = options.logger ?? createLogger('Unity');
    this.log = log;
    this.scene = new UnitySceneManager(options.unity);
    this.objects = new UnityGameObjectManager(options.unity);
    this.importer = new UnityAssetImporter(options.unity, options.unityProjectPath, log.scope('Import'));
    this.materials = new UnityMaterialManager(options.unity);
    this.camera = new UnityCameraManager(options.unity);
  }

  /** Full scene construction (also used for corrections re-apply). */
  async build(plan: ScenePlan, manifest: AssetManifest | undefined, localPaths: Map<string, string>): Promise<SceneBuildResult> {
    const warnings: string[] = [];
    let proceduralObjects = 0;
    let instantiatedAssets = 0;
    let primitivesCreated = 0;
    let objectsPlaced = 0;

    this.log.info('Constructing environment...');
    if (!this.constructed) {
      await this.scene.create(plan.sceneName);
      await this.objects.createEmpty(ROOT);
      await this.objects.createEmpty(`${ROOT}/Environment`);
      await this.objects.createEmpty(`${ROOT}/Architecture`);
      await this.objects.createEmpty(`${ROOT}/Vegetation`);
      await this.objects.createEmpty(`${ROOT}/Props`);
      await this.objects.createEmpty(`${ROOT}/Vehicles`);
    }

    const objectToAsset = new Map<string, string>();
    for (const spec of manifest?.assets ?? []) {
      for (const objId of spec.objectIds) objectToAsset.set(objId, spec.id);
    }

    for (const obj of plan.objects) {
      const group = groupFor(obj.category);
      const path = joinPath(`${ROOT}/${group}`, obj.name);
      const assetId = objectToAsset.get(obj.id);
      const spec = assetId ? manifest?.assets.find((a) => a.id === assetId) : undefined;
      const method = spec?.generationMethod ?? 'primitive';
      const transform = { position: obj.position, rotation: { x: 0, y: obj.rotationY, z: 0 }, scale: obj.scale };

      try {
        if (method === 'procedural') {
          if (!this.constructed) await this.proceduralObject(obj, path, transform);
          proceduralObjects++;
        } else if (method === 'meshy_text' || method === 'meshy_image' || method === 'existing_asset') {
          const localPath = assetId ? localPaths.get(assetId) : undefined;
          if (localPath) {
            const unityAssetPath = `Assets/GODCP/${plan.project}/${assetId}/${basenameOf(localPath)}`;
            if (!this.constructed) await this.importer.importModel(localPath, unityAssetPath);
            if (this.constructed) {
              await this.objects.setTransform(path, transform);
            } else {
              await this.objects.instantiate(unityAssetPath, obj.name, transform, `${ROOT}/${group}`);
            }
            instantiatedAssets++;
          } else {
            // asset unavailable → primitive fallback (never a silent hole in the scene)
            warnings.push(`Asset for "${obj.id}" unavailable — created primitive fallback.`);
            if (!this.constructed) await this.objects.createPrimitive('cube', path, transform);
            primitivesCreated++;
          }
        } else {
          const kind = spec?.primitiveType && spec.primitiveType !== 'quad' && spec.primitiveType !== 'cylinder_capsule' ? spec.primitiveType : 'cube';
          if (this.constructed) await this.objects.setTransform(path, transform);
          else await this.objects.createPrimitive(kind as any, path, transform);
          primitivesCreated++;
        }
        objectsPlaced++;

        const material = materialFor(obj, plan.materials);
        if (material) await this.materials.set(path, material);
      } catch (err) {
        warnings.push(`Failed to place "${obj.name}": ${err instanceof Error ? err.message : String(err)}`);
        this.log.warn(`Failed to place "${obj.name}"`, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Lighting + camera + render settings
    try {
      await this.camera.createLight({
        name: 'Directional Light',
        type: 'directional',
        transform: { position: { x: 0, y: 20, z: 0 }, rotation: directionToEuler(plan.lighting.sunDirection) },
        colorHex: plan.lighting.sunColorHex,
        intensity: plan.lighting.sunIntensity,
        shadows: plan.lighting.shadows,
      });
      await this.camera.setRenderSettings({
        ambientColorHex: plan.lighting.ambientColorHex,
        ambientIntensity: plan.lighting.ambientIntensity,
        fog: plan.lighting.fogEnabled,
        fogColorHex: plan.lighting.fogColorHex,
        fogDensity: plan.lighting.fogDensity,
      });
      await this.applyCamera(plan);
    } catch (err) {
      warnings.push(`Lighting/camera setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await this.scene.save();
    } catch (err) {
      this.log.warn('Scene save reported an error', { error: err instanceof Error ? err.message : String(err) });
      warnings.push(`Scene save failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.constructed = true;
    this.log.info(`Environment constructed: ${objectsPlaced} objects placed.`);
    return { proceduralObjects, instantiatedAssets, primitivesCreated, objectsPlaced, warnings };
  }

  async applyCamera(plan: ScenePlan): Promise<void> {
    await this.camera.configure({
      name: plan.camera.name,
      position: plan.camera.position,
      lookAt: plan.camera.lookAt,
      direction: plan.camera.direction,
      fov: plan.camera.fov,
      near: plan.camera.near,
      far: plan.camera.far,
    });
  }

  /** Update lighting from a corrected plan without rebuilding objects. */
  async applyLighting(plan: ScenePlan): Promise<void> {
    await this.camera.createLight({
      name: 'Directional Light',
      type: 'directional',
      transform: { position: { x: 0, y: 20, z: 0 }, rotation: directionToEuler(plan.lighting.sunDirection) },
      colorHex: plan.lighting.sunColorHex,
      intensity: plan.lighting.sunIntensity,
      shadows: plan.lighting.shadows,
    });
    await this.camera.setRenderSettings({
      ambientColorHex: plan.lighting.ambientColorHex,
      ambientIntensity: plan.lighting.ambientIntensity,
      fog: plan.lighting.fogEnabled,
      fogColorHex: plan.lighting.fogColorHex,
      fogDensity: plan.lighting.fogDensity,
    });
  }

  private async proceduralObject(obj: SceneObject, path: string, transform: { position: any; rotation: any; scale: any }): Promise<void> {
    switch (obj.category) {
      case 'terrain':
        await this.objects.createPrimitive('plane', path, { position: { x: 0, y: 0, z: obj.position.z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: obj.scale.x / 10, y: 1, z: obj.scale.z / 10 } });
        break;
      case 'road':
        await this.objects.createPrimitive('cube', path, transform);
        break;
      case 'sidewalk':
        await this.objects.createPrimitive('cube', path, transform);
        break;
      case 'water':
        await this.objects.createPrimitive('plane', path, { ...transform, scale: { x: transform.scale.x / 10, y: 1, z: transform.scale.z / 10 } });
        break;
      default:
        await this.objects.createPrimitive('cube', path, transform);
    }
  }
}

function groupFor(category: SceneObject['category']): string {
  switch (category) {
    case 'terrain':
    case 'road':
    case 'sidewalk':
    case 'water':
      return 'Environment';
    case 'building':
      return 'Architecture';
    case 'vegetation':
      return 'Vegetation';
    case 'vehicle':
      return 'Vehicles';
    case 'prop':
      return 'Props';
    case 'character':
      return 'Characters';
    default:
      return 'Props';
  }
}

function materialFor(obj: SceneObject, materials: MaterialSpec[]): { colorHex: string; name: string; roughness?: number; metallic?: number } | undefined {
  const kindMap: Record<SceneObject['category'], MaterialSpec['kind']> = {
    terrain: 'terrain',
    road: 'road',
    sidewalk: 'road',
    building: 'building',
    vegetation: 'foliage',
    water: 'water',
    vehicle: 'metal',
    prop: 'standard',
    character: 'standard',
    marker: 'standard',
  };
  const material = materials.find((m) => m.kind === kindMap[obj.category]);
  if (!material) return undefined;
  return { colorHex: material.colorHex, name: material.name, roughness: material.roughness, metallic: material.metallic };
}

function directionToEuler(dir: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const pitch = (Math.atan2(Math.hypot(dir.x, dir.z), dir.y) * 180) / Math.PI;
  const yaw = (Math.atan2(dir.x, dir.z) * 180) / Math.PI;
  return { x: pitch, y: yaw, z: 0 };
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
