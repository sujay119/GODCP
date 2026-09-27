import type { ScenePlan, ReferenceAnalysis, HierarchyNode, SceneObject, MaterialSpec, SpatialRelationship } from '../models/ScenePlan.js';
import { scenePlanSchema } from '../models/ScenePlan.js';
import { GODCPError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

export interface ScenePlannerInput {
  project: string;
  sceneName: string;
  analysis: ReferenceAnalysis;
}

/**
 * Converts a ReferenceAnalysis into a serializable ScenePlan.
 * Deterministic rule-based engine — reasons about what is visible, what is
 * important and where it goes. Never invents precision it does not have;
 * per-object confidence is carried through from the analysis.
 */
export function createScenePlan(input: ScenePlannerInput): ScenePlan {
  const log = createLogger('ScenePlanner');
  const { analysis } = input;
  const warnings: string[] = [...analysis.warnings];
  const objects: SceneObject[] = [];
  const materials: MaterialSpec[] = [];
  const relationships: SpatialRelationship[] = [];

  const style = analysis.visualStyle || 'realistic';
  const env = analysis.environmentType;

  // 1) Ground / terrain — always present
  objects.push({
    id: 'terrain_main',
    name: 'Terrain',
    category: 'terrain',
    type: analysis.geometry.terrain,
    position: { x: 0, y: 0, z: -30 },
    rotationY: 0,
    scale: { x: 120, y: 0.2, z: 120 },
    importance: 1,
    confidence: Math.max(0.5, analysis.confidence),
    notes: 'base ground plane',
  });

  // 2) Road / sidewalk
  if (analysis.geometry.road) {
    objects.push({
      id: 'road_main',
      name: 'Road',
      category: 'road',
      type: 'asphalt',
      position: { x: 0, y: 0.02, z: -30 },
      rotationY: 0,
      scale: { x: 9, y: 0.1, z: 100 },
      importance: 0.9,
      confidence: Math.max(0.45, analysis.confidence),
    });
    if (analysis.geometry.sidewalk) {
      objects.push(
        { id: 'sidewalk_left', name: 'Sidewalk_L', category: 'sidewalk', type: 'concrete', position: { x: -6.5, y: 0.05, z: -30 }, rotationY: 0, scale: { x: 4, y: 0.15, z: 100 }, importance: 0.6, confidence: 0.5 },
        { id: 'sidewalk_right', name: 'Sidewalk_R', category: 'sidewalk', type: 'concrete', position: { x: 6.5, y: 0.05, z: -30 }, rotationY: 0, scale: { x: 4, y: 0.15, z: 100 }, importance: 0.6, confidence: 0.5 },
      );
    }
  }

  // 3) Objects from the analysis (dedupe by type+side naming)
  const usedIds = new Set(objects.map((o) => o.id));
  for (const ref of analysis.objects) {
    if (ref.type === 'road' || ref.type === 'terrain') continue; // already handled
    const id = slug(ref.name);
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    const category = categoryFor(ref.type);
    objects.push({
      id,
      name: pascal(ref.name),
      category,
      type: ref.type,
      position: ref.estimatedPosition ?? defaultPosition(category, objects.length),
      rotationY: 0,
      scale: ref.estimatedScale ?? defaultScale(category),
      importance: ref.importance,
      confidence: ref.confidence,
      notes: ref.notes,
    });
  }

  // 4) Fill environment-type expectations the vision model may have missed
  if (analysis.geometry.buildings && !objects.some((o) => o.category === 'building')) {
    objects.push(
      { id: 'building_left', name: 'Building_Left', category: 'building', type: 'building', position: { x: -11, y: 7, z: -20 }, rotationY: 0, scale: { x: 9, y: 14, z: 10 }, importance: 0.85, confidence: 0.45, notes: 'added: analysis flagged buildings but listed none' },
      { id: 'building_right', name: 'Building_Right', category: 'building', type: 'building', position: { x: 11, y: 7, z: -24 }, rotationY: 0, scale: { x: 9, y: 14, z: 10 }, importance: 0.8, confidence: 0.45, notes: 'added: analysis flagged buildings but listed none' },
    );
    warnings.push('Buildings detected but not localized — placed flanking the street with reduced confidence.');
  }
  if (analysis.geometry.vegetation && !objects.some((o) => o.category === 'vegetation')) {
    objects.push({ id: 'tree_01', name: 'Tree_01', category: 'vegetation', type: 'tree', position: { x: -7.5, y: 0, z: -14 }, rotationY: 0, scale: { x: 1, y: 5, z: 1 }, importance: 0.55, confidence: 0.45, notes: 'added: analysis flagged vegetation but listed none' });
  }
  if (analysis.geometry.vehicles && !objects.some((o) => o.category === 'vehicle')) {
    objects.push({ id: 'car_01', name: 'Car_01', category: 'vehicle', type: 'car', position: { x: 2.5, y: 0, z: -12 }, rotationY: 180, scale: { x: 1.9, y: 1.5, z: 4.4 }, importance: 0.7, confidence: 0.45, notes: 'added: analysis flagged vehicles but listed none' });
  }

  // 5) Materials from dominant colors
  const dominant = analysis.colors.dominant;
  materials.push({ id: 'mat_terrain', name: 'TerrainMat', kind: 'terrain', colorHex: dominant[3] ?? '#6f7a5a', roughness: 0.95 });
  if (analysis.geometry.road) materials.push({ id: 'mat_road', name: 'RoadMat', kind: 'road', colorHex: '#46464a', roughness: 0.9 });
  if (analysis.geometry.buildings) materials.push({ id: 'mat_building', name: 'BuildingMat', kind: 'building', colorHex: dominant[1] ?? '#9a938a', roughness: 0.8 });
  if (analysis.geometry.vegetation) materials.push({ id: 'mat_foliage', name: 'FoliageMat', kind: 'foliage', colorHex: '#3f7a44', roughness: 0.85 });
  for (const m of analysis.materials) {
    if (!materials.some((x) => x.name.toLowerCase().includes(m.name.toLowerCase()))) {
      materials.push({ id: slug(m.name), name: pascal(m.name), kind: normalizeMaterialKind(m.kind), colorHex: '#8a8a8a', notes: `detected (${Math.round(m.confidence * 100)}% confidence)` });
    }
  }

  // 6) Spatial relationships (left/right ordering of buildings, etc.)
  const buildingsL = objects.find((o) => o.id.includes('left'));
  const buildingsR = objects.find((o) => o.id.includes('right'));
  if (buildingsL && buildingsR) {
    relationships.push({ a: buildingsL.id, relation: 'left_of', b: buildingsR.id, confidence: Math.max(0.5, buildingsL.confidence) });
  }

  // 7) Camera & lighting via planners
  const camera = planCameraFromAnalysis(analysis);
  const lighting = planLightingFromAnalysis(analysis);

  // 8) Reuse opportunities: identical types collapse to one asset
  const byType = new Map<string, SceneObject[]>();
  for (const o of objects) {
    const key = `${o.category}:${o.type}`;
    byType.set(key, [...(byType.get(key) ?? []), o]);
  }
  const reuse = [...byType.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ objectId: list[0].id, reason: `all "${key}" objects share one asset`, instances: list.length }));

  // 9) Hierarchy
  const rootChildren: HierarchyNode[] = [
    node('Environment', [
      node('Terrain', objects.filter((o) => o.category === 'terrain').map(objNode)),
      node('Roadway', objects.filter((o) => o.category === 'road' || o.category === 'sidewalk').map(objNode)),
    ]),
    node('Architecture', objects.filter((o) => o.category === 'building').map(objNode)),
    node('Vegetation', objects.filter((o) => o.category === 'vegetation').map(objNode)),
    node('Props', objects.filter((o) => o.category === 'prop').map(objNode)),
    node('Vehicles', objects.filter((o) => o.category === 'vehicle').map(objNode)),
    node('Characters', objects.filter((o) => o.category === 'character').map(objNode)),
    node('Lighting', [node('Directional Light')]),
    node(camera.name),
  ].filter((n) => n.children.length > 0 || n.name === camera.name || n.name === 'Lighting');

  const assetRequirements = objects
    .filter((o) => o.category !== 'terrain' && o.category !== 'road' && o.category !== 'sidewalk' && o.category !== 'marker')
    .map((o) => o.id);

  const plan: ScenePlan = {
    schemaVersion: '1.0',
    project: input.project,
    sceneName: input.sceneName,
    environmentType: env,
    visualStyle: style,
    confidence: analysis.confidence,
    terrainType: analysis.geometry.terrain,
    worldSize: { width: 120, depth: 120 },
    objects,
    spatialRelationships: relationships,
    hierarchy: { name: input.sceneName, children: rootChildren },
    camera,
    lighting,
    atmosphere: {
      timeOfDay: analysis.lighting.timeOfDay,
      weather: analysis.atmosphere.weather,
      mood: analysis.atmosphere.mood,
      fogColorHex: analysis.colors.averageHex,
      notes: analysis.compositionNotes.join(' '),
    },
    materials,
    assetRequirements,
    reuseOpportunities: reuse,
    warnings,
  };

  const parsed = scenePlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new GODCPError('PLAN_VALIDATION_FAILED', `Generated scene plan failed validation: ${parsed.error.issues[0]?.message}`, {
      stage: 'planning',
      details: { issues: parsed.error.issues.slice(0, 8) },
    });
  }
  log.info(`Scene plan created: ${objects.length} objects, ${assetRequirements.length} asset requirements.`, { scene: input.sceneName });
  return parsed.data;
}

function planCameraFromAnalysis(analysis: ReferenceAnalysis): ScenePlan['camera'] {
  return {
    name: 'GODCPCamera',
    position: analysis.composition.cameraPosition,
    direction: analysis.composition.cameraDirection,
    lookAt: {
      x: analysis.composition.cameraPosition.x + analysis.composition.cameraDirection.x * 10,
      y: analysis.composition.cameraPosition.y + analysis.composition.cameraDirection.y * 10,
      z: analysis.composition.cameraPosition.z + analysis.composition.cameraDirection.z * 10,
    },
    fov: analysis.composition.estimatedFov,
    near: 0.1,
    far: 2000,
    confidence: analysis.composition.confidence,
  };
}

function planLightingFromAnalysis(analysis: ReferenceAnalysis): ScenePlan['lighting'] {
  const dir = analysis.lighting.direction ?? { x: -0.4, y: 0.8, z: -0.3 };
  const bright = analysis.lighting.intensityHint;
  const base = bright === 'bright' ? 1.7 : bright === 'dim' ? 0.55 : 1.2;
  const night = analysis.lighting.timeOfDay === 'night';
  return {
    sunDirection: dir,
    sunIntensity: night ? 0.15 : base,
    sunColorHex: analysis.lighting.timeOfDay === 'golden_hour' ? '#ffd39a' : night ? '#9db4ff' : '#fff4e0',
    ambientIntensity: night ? 0.25 : 0.6,
    ambientColorHex: night ? '#243046' : '#8899aa',
    fogEnabled: analysis.atmosphere.fog,
    fogColorHex: analysis.colors.averageHex ?? '#c9d6e3',
    fogDensity: analysis.atmosphere.fog ? 0.02 : 0,
    shadows: analysis.lighting.shadows,
    confidence: analysis.lighting.confidence,
  };
}

function node(name: string, children: HierarchyNode[] = []): HierarchyNode {
  return { name, children };
}
function objNode(o: SceneObject): HierarchyNode {
  return { name: o.name, objectId: o.id, children: [] };
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'object';
}
function pascal(s: string): string {
  return s.split(/[_\s-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('_');
}
function categoryFor(type: string): SceneObject['category'] {
  const t = type.toLowerCase();
  if (t.includes('building') || t.includes('house') || t.includes('structure')) return 'building';
  if (t.includes('tree') || t.includes('bush') || t.includes('plant') || t.includes('vegetation') || t.includes('grass')) return 'vegetation';
  if (t.includes('car') || t.includes('vehicle') || t.includes('truck') || t.includes('bus')) return 'vehicle';
  if (t.includes('person') || t.includes('character')) return 'character';
  if (t.includes('lamp') || t.includes('bench') || t.includes('sign') || t.includes('bin') || t.includes('hydrant') || t.includes('vending')) return 'prop';
  if (t.includes('water') || t.includes('river') || t.includes('lake')) return 'water';
  if (t.includes('road') || t.includes('street')) return 'road';
  if (t.includes('sidewalk') || t.includes('pavement')) return 'sidewalk';
  if (t.includes('terrain') || t.includes('ground')) return 'terrain';
  return 'prop';
}
function defaultPosition(cat: SceneObject['category'], index: number): { x: number; y: number; z: number } {
  const side = index % 2 === 0 ? -1 : 1;
  switch (cat) {
    case 'building': return { x: side * 11, y: 7, z: -18 - index * 2 };
    case 'vegetation': return { x: side * 7.5, y: 0, z: -12 - index };
    case 'vehicle': return { x: side * 2.5, y: 0, z: -12 };
    case 'prop': return { x: side * 6, y: 0, z: -8 - index };
    default: return { x: side * 4, y: 0, z: -10 - index };
  }
}
function defaultScale(cat: SceneObject['category']): { x: number; y: number; z: number } {
  switch (cat) {
    case 'building': return { x: 9, y: 14, z: 9 };
    case 'vegetation': return { x: 1, y: 5, z: 1 };
    case 'vehicle': return { x: 1.9, y: 1.5, z: 4.4 };
    case 'prop': return { x: 0.6, y: 3, z: 0.6 };
    default: return { x: 1, y: 1, z: 1 };
  }
}
function normalizeMaterialKind(kind: string): MaterialSpec['kind'] {
  const k = kind.toLowerCase();
  if (k.includes('road') || k.includes('asphalt')) return 'road';
  if (k.includes('foliage') || k.includes('leaf')) return 'foliage';
  if (k.includes('glass')) return 'glass';
  if (k.includes('metal')) return 'metal';
  if (k.includes('water')) return 'water';
  if (k.includes('terrain') || k.includes('soil') || k.includes('grass')) return 'terrain';
  if (k.includes('build') || k.includes('concrete') || k.includes('brick')) return 'building';
  return 'standard';
}
