import type { CameraPlan, ReferenceAnalysis, ScenePlan } from '../models/ScenePlan.js';

/**
 * Derives the camera that should reproduce the reference framing.
 * Uses the analysis composition directly, sanity-clamps values, and computes
 * look-at so Unity camera configuration is deterministic.
 */
export function planCamera(analysis: ReferenceAnalysis, plan?: ScenePlan): CameraPlan {
  const pos = analysis.composition.cameraPosition;
  const dir = normalize(analysis.composition.cameraDirection);
  const fov = clamp(analysis.composition.estimatedFov, 15, 120);

  // Keep the camera above ground and outside geometry
  const position = { x: pos.x, y: Math.max(0.5, pos.y), z: pos.z };
  const lookAt = { x: position.x + dir.x * 20, y: position.y + dir.y * 20, z: position.z + dir.z * 20 };

  return {
    name: plan?.camera.name ?? 'GODCPCamera',
    position,
    direction: dir,
    lookAt,
    fov,
    near: 0.1,
    far: 2000,
    confidence: analysis.composition.confidence,
  };
}

/** Apply a camera correction produced by the iteration engine. */
export function applyCameraCorrection(camera: CameraPlan, params: Record<string, unknown>): CameraPlan {
  const next: CameraPlan = { ...camera };
  if (Array.isArray(params.position) && params.position.length === 3) {
    next.position = { x: Number(params.position[0]), y: Number(params.position[1]), z: Number(params.position[2]) };
  } else if (params.position && typeof params.position === 'object') {
    next.position = { ...next.position, ...(params.position as object) } as CameraPlan['position'];
  }
  if (typeof params.fov === 'number') next.fov = clamp(params.fov, 15, 120);
  if (typeof params.horizonShiftRows === 'number') {
    next.position = { ...next.position, y: Math.max(0.5, next.position.y - params.horizonShiftRows * 0.25) };
  }
  if (next.direction) {
    next.lookAt = {
      x: next.position.x + next.direction.x * 20,
      y: next.position.y + next.direction.y * 20,
      z: next.position.z + next.direction.z * 20,
    };
  }
  return next;
}

function normalize(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
