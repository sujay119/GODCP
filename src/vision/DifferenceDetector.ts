import type { ComparisonResult, Correction, Difference } from '../models/ComparisonResult.js';
import type { ImageStats } from './imageStats.js';
import { colorDistance } from './imageStats.js';

export interface DiffContext {
  sceneName?: string;
  objectNames?: string[];
  similarityTarget?: number;
}

/**
 * Pixel-level difference detection between reference and render.
 * Produces semantic differences + actionable corrections, not just a score.
 */
export function detectHeuristicDifferences(ref: ImageStats, render: ImageStats, context: DiffContext = {}): ComparisonResult {
  const differences: Difference[] = [];
  const corrections: Correction[] = [];
  const warnings = ['Heuristic pixel comparison — semantic accuracy is limited; configure a vision LLM for richer diffs.'];

  // 1) Global brightness → lighting
  const brightnessDelta = render.brightness - ref.brightness;
  if (Math.abs(brightnessDelta) > 18) {
    const darker = brightnessDelta < 0;
    differences.push({
      type: 'lighting',
      description: darker ? 'Render is darker than the reference.' : 'Render is brighter than the reference.',
      expected: `brightness ≈ ${Math.round(ref.brightness)}`,
      observed: `brightness ≈ ${Math.round(render.brightness)}`,
      confidence: 0.8,
      severity: Math.abs(brightnessDelta) > 45 ? 'high' : 'medium',
    });
    const factor = clamp(Number((1 + (darker ? 0.25 : -0.2)).toFixed(2)), 0.2, 3);
    corrections.push({
      action: 'relight',
      target: 'directional_light',
      params: { intensityFactor: darker ? 1.3 : 0.75, ambientFactor: darker ? 1.25 : 0.8 },
      rationale: `Overall luminance differs by ${Math.round(brightnessDelta)} levels.`,
      confidence: 0.75,
    });
    void factor;
  }

  // 2) Color cast → color/material mismatch
  const cast = colorDistance(ref.average, render.average);
  if (cast > 32) {
    differences.push({
      type: 'color',
      description: 'Overall color cast differs between render and reference.',
      expected: `avg ${hex(ref.average)}`,
      observed: `${hex(render.average)}`,
      confidence: 0.7,
      severity: cast > 70 ? 'high' : 'medium',
    });
    corrections.push({
      action: 'recolor',
      target: 'scene_materials',
      params: { targetAverageHex: hex(ref.average), currentAverageHex: hex(render.average), delta: Math.round(cast) },
      rationale: 'Average scene color differs noticeably from the reference.',
      confidence: 0.6,
    });
  }

  // 3) Layout: compare bright/content mass distribution across the 8×6 grid
  const layoutScore = layoutSimilarity(ref, render);
  if (layoutScore < 0.62) {
    const heavierLeft = contentMass(ref, 'left') > contentMass(ref, 'right');
    differences.push({
      type: 'composition',
      description: 'Spatial composition of the render does not match the reference layout.',
      expected: `reference layout similarity ${(layoutScore * 100).toFixed(0)}%`,
      observed: 'rearranged content distribution',
      confidence: 0.6,
      severity: layoutScore < 0.4 ? 'high' : 'medium',
    });
    corrections.push({
      action: 'move',
      target: context.objectNames?.[0] ?? 'major_objects',
      params: { hint: heavierLeft ? 'shift mass toward the left side' : 'shift mass toward the right side', layoutScore: Number(layoutScore.toFixed(2)) },
      rationale: 'Grid content distribution differs from the reference.',
      confidence: 0.5,
    });
    // scale correction for the most important named object
    const target = context.objectNames?.[0];
    if (target) {
      corrections.push({
        action: 'scale',
        target,
        params: { factor: 1.15 },
        rationale: 'Content occupies a smaller/larger fraction of frame than the reference.',
        confidence: 0.45,
      });
    }
  }

  // 4) Horizon shift → camera pitch/height
  const refHorizon = horizonRow(ref);
  const renHorizon = horizonRow(render);
  if (Math.abs(refHorizon - renHorizon) >= 1) {
    differences.push({
      type: 'camera',
      description: 'Horizon line position differs — camera height or pitch is off.',
      expected: `horizon at row ${refHorizon}/${ref.rows}`,
      observed: `horizon at row ${renHorizon}/${render.rows}`,
      confidence: 0.55,
      severity: 'medium',
    });
    corrections.push({
      action: 'recamera',
      target: 'camera',
      params: { horizonShiftRows: renHorizon - refHorizon, adjust: renHorizon > refHorizon ? 'lower camera or tilt up' : 'raise camera or tilt down' },
      rationale: 'Horizon rows differ between reference and render.',
      confidence: 0.5,
    });
  }

  // 5) Green mass → vegetation missing/extra
  const refGreen = greenFraction(ref);
  const renGreen = greenFraction(render);
  if (Math.abs(refGreen - renGreen) > 0.12) {
    const missing = refGreen > renGreen;
    differences.push({
      type: missing ? 'missing_object' : 'extra_object',
      object: 'vegetation',
      description: missing ? 'Reference contains more vegetation than the render.' : 'Render contains more vegetation than the reference.',
      expected: `${(refGreen * 100).toFixed(0)}% green coverage`,
      observed: `${(renGreen * 100).toFixed(0)}% green coverage`,
      confidence: 0.55,
      severity: 'low',
    });
    corrections.push({
      action: missing ? 'add_object' : 'remove_object',
      target: 'vegetation_cluster',
      params: { coverageDelta: Number((refGreen - renGreen).toFixed(2)) },
      rationale: 'Vegetation coverage differs.',
      confidence: 0.5,
    });
  }

  // Similarity = weighted blend (NOT the only signal — see differences above)
  const colorScore = clamp(1 - cast / 160, 0, 1);
  const brightScore = clamp(1 - Math.abs(brightnessDelta) / 180, 0, 1);
  const overallSimilarity = clamp(Number((0.4 * layoutScore + 0.3 * colorScore + 0.3 * brightScore).toFixed(3)), 0, 1);

  const summary = `${differences.length} difference(s) detected; similarity ${(overallSimilarity * 100).toFixed(0)}%` +
    (context.similarityTarget ? ` (target ${(context.similarityTarget * 100).toFixed(0)}%)` : '');

  return { overallSimilarity, differences, corrections, summary, method: 'heuristic', warnings };
}

function layoutSimilarity(a: ImageStats, b: ImageStats): number {
  const ca = contentProfile(a);
  const cb = contentProfile(b);
  let diff = 0;
  for (let i = 0; i < ca.length; i++) diff += Math.abs(ca[i] - cb[i]);
  return clamp(1 - diff / (ca.length * 255), 0, 1);
}

/** Per-cell luminance profile. */
function contentProfile(s: ImageStats): number[] {
  return s.grid.map((c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
}

function contentMass(s: ImageStats, side: 'left' | 'right'): number {
  let total = 0;
  for (let gy = 0; gy < s.rows; gy++) {
    for (let gx = 0; gx < s.cols; gx++) {
      const inSide = side === 'left' ? gx < s.cols / 2 : gx >= s.cols / 2;
      if (inSide) total += contentProfile(s)[gy * s.cols + gx];
    }
  }
  return total;
}

function horizonRow(s: ImageStats): number {
  for (let gy = 0; gy < s.rows; gy++) {
    let sky = 0;
    for (let gx = 0; gx < s.cols; gx++) {
      const c = s.grid[gy * s.cols + gx];
      if (c.b > c.r + 8 && 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 90) sky++;
    }
    if (sky <= Math.floor(s.cols / 2)) return gy;
  }
  return Math.floor(s.rows / 2);
}

function greenFraction(s: ImageStats): number {
  let green = 0;
  for (const c of s.grid) if (c.g > c.r + 12 && c.g > c.b + 12) green++;
  return green / s.grid.length;
}

function hex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
