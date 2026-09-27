import type { LightingPlan, ReferenceAnalysis, ScenePlan } from '../models/ScenePlan.js';

/**
 * Derives sun/ambient/fog settings that should reproduce the reference
 * lighting. Intensity is scaled from the analysis brightness hint and time of
 * day; direction is estimated from shading/color temperature cues.
 */
export function planLighting(analysis: ReferenceAnalysis, plan?: ScenePlan): LightingPlan {
  const base = plan?.lighting;
  const hint = analysis.lighting.intensityHint;
  const night = analysis.lighting.timeOfDay === 'night';

  const sunIntensity = night ? 0.15 : hint === 'bright' ? 1.7 : hint === 'dim' ? 0.55 : 1.2;
  const direction = analysis.lighting.direction ?? { x: -0.4, y: 0.8, z: -0.3 };
  const len = Math.hypot(direction.x, direction.y, direction.z) || 1;

  return {
    sunDirection: { x: direction.x / len, y: direction.y / len, z: direction.z / len },
    sunIntensity,
    sunColorHex: analysis.lighting.timeOfDay === 'golden_hour' ? '#ffd39a' : night ? '#9db4ff' : '#fff4e0',
    ambientIntensity: night ? 0.25 : 0.6,
    ambientColorHex: night ? '#243046' : '#8899aa',
    fogEnabled: analysis.atmosphere.fog,
    fogColorHex: analysis.colors.averageHex ?? base?.fogColorHex ?? '#c9d6e3',
    fogDensity: analysis.atmosphere.fog ? 0.02 : 0,
    shadows: analysis.lighting.shadows,
    confidence: analysis.lighting.confidence,
  };
}

/** Apply a relight correction from the iteration engine. */
export function applyLightingCorrection(lighting: LightingPlan, params: Record<string, unknown>): LightingPlan {
  const next: LightingPlan = { ...lighting };
  if (typeof params.intensityFactor === 'number') {
    next.sunIntensity = clamp(next.sunIntensity * params.intensityFactor, 0, 8);
  }
  if (typeof params.ambientFactor === 'number') {
    next.ambientIntensity = clamp(next.ambientIntensity * params.ambientFactor, 0, 4);
  }
  if (typeof params.sunColorHex === 'string') next.sunColorHex = params.sunColorHex;
  if (typeof params.ambientColorHex === 'string') next.ambientColorHex = params.ambientColorHex;
  if (typeof params.fog === 'boolean') next.fogEnabled = params.fog;
  if (typeof params.fogDensity === 'number') next.fogDensity = clamp(params.fogDensity, 0, 1);
  if (Array.isArray(params.sunDirection) && params.sunDirection.length === 3) {
    next.sunDirection = { x: Number(params.sunDirection[0]), y: Number(params.sunDirection[1]), z: Number(params.sunDirection[2]) };
  }
  return next;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
