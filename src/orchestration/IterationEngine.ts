import { join } from 'node:path';
import { createLogger, type Logger } from '../utils/logger.js';
import { ensureDir } from '../utils/fileSystem.js';
import type { ScenePlan, SceneObject } from '../models/ScenePlan.js';
import type { ComparisonResult, Correction } from '../models/ComparisonResult.js';
import type { IterationRecord } from '../models/BuildReport.js';
import type { ProjectState } from '../registry/ProjectState.js';
import type { SceneComparator } from '../vision/SceneComparator.js';
import type { UnityRenderer } from '../unity/UnityRenderer.js';
import { applyCameraCorrection } from '../planner/cameraPlanner.js';
import { applyLightingCorrection } from '../planner/lightingPlanner.js';
import type { ScenePipeline } from './ScenePipeline.js';

export interface IterationEngineOptions {
  comparator: SceneComparator;
  renderer: UnityRenderer;
  pipeline: ScenePipeline;
  state: ProjectState;
  renderDir: string;
  referenceImagePath: string;
  maxIterations: number;
  similarityTarget: number;
  logger?: Logger;
}

export interface IterationOutcome {
  iterations: number;
  finalSimilarity: number;
  finalRenderPath?: string;
  comparisons: ComparisonResult[];
  warnings: string[];
  reachedTarget: boolean;
}

/**
 * Render → compare → correct → re-apply loop. Persists every iteration record
 * for auditability/resume and stops at maxIterations or the similarity target.
 */
export class IterationEngine {
  private readonly log: Logger;

  constructor(private readonly options: IterationEngineOptions) {
    this.log = options.logger ?? createLogger('Iteration');
  }

  async run(plan: ScenePlan, localPaths: Map<string, string>, startIteration = 1): Promise<{ outcome: IterationOutcome; plan: ScenePlan }> {
    const { maxIterations, similarityTarget, state, renderDir, referenceImagePath } = this.options;
    const warnings: string[] = [];
    const comparisons: ComparisonResult[] = [];
    let currentPlan = plan;
    let lastSimilarity = 0;
    let lastRender: string | undefined;
    let iterationsRun = 0;
    let reachedTarget = false;

    await ensureDir(renderDir);

    for (let i = startIteration; i <= maxIterations; i++) {
      this.log.info(`Render ${i} starting...`);
      const renderPath = join(renderDir, `iteration-${String(i).padStart(2, '0')}.png`);
      const saved = await state.loadState();
      try {
        lastRender = await this.options.renderer.render(renderPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Render ${i} failed: ${msg}`);
        this.log.error(`Render ${i} failed: ${msg}`);
        break;
      }

      const comparison = await this.options.comparator.compare(referenceImagePath, lastRender, {
        sceneName: currentPlan.sceneName,
        objectNames: currentPlan.objects.filter((o) => o.importance >= 0.6).map((o) => o.name),
        similarityTarget,
      });
      comparisons.push(comparison);
      lastSimilarity = comparison.overallSimilarity;

      const record: IterationRecord = {
        iteration: i,
        timestamp: new Date().toISOString(),
        renderPath: lastRender,
        comparison,
        correctionsApplied: 0,
        similarity: comparison.overallSimilarity,
      };

      await state.appendComparison(comparison);

      if (comparison.overallSimilarity >= similarityTarget) {
        record.correctionsApplied = 0;
        await state.saveIteration(record);
        reachedTarget = true;
        this.log.info(`Similarity target reached (${(comparison.overallSimilarity * 100).toFixed(0)}% ≥ ${(similarityTarget * 100).toFixed(0)}%) after ${i} iteration(s).`);
        iterationsRun = i;
        break;
      }

      if (i >= maxIterations) {
        await state.saveIteration(record);
        iterationsRun = i;
        this.log.info(`Max iterations (${maxIterations}) reached. Final similarity ${(comparison.overallSimilarity * 100).toFixed(0)}%.`);
        break;
      }

      // Apply corrections → updated plan → Unity
      const applied = await this.applyCorrections(currentPlan, comparison.corrections, localPaths, i);
      currentPlan = applied.plan;
      record.correctionsApplied = applied.appliedCount;
      await state.saveIteration(record);
      await state.savePlan(currentPlan);
      iterationsRun = i;
      this.log.info(`Render ${i} complete.`, { similarity: comparison.overallSimilarity, correctionsApplied: applied.appliedCount });
      if (saved) {
        await state.saveState({ ...saved, iterationCount: i, lastSimilarity: comparison.overallSimilarity });
      }
    }

    return {
      outcome: {
        iterations: iterationsRun,
        finalSimilarity: lastSimilarity,
        finalRenderPath: lastRender,
        comparisons,
        warnings,
        reachedTarget,
      },
      plan: currentPlan,
    };
  }

  private async applyCorrections(
    plan: ScenePlan,
    corrections: Correction[],
    localPaths: Map<string, string>,
    iteration: number,
  ): Promise<{ plan: ScenePlan; appliedCount: number }> {
    if (corrections.length === 0) return { plan, appliedCount: 0 };
    const next: ScenePlan = structuredClone(plan);
    let applied = 0;
    let needFullRebuild = false;
    let needCamera = false;
    let needLighting = false;

    for (const c of corrections) {
      try {
        switch (c.action) {
          case 'scale': {
            const target = findTarget(next, c.target);
            if (target) {
              const factor = typeof c.params.factor === 'number' ? c.params.factor : 1.1;
              target.scale = { x: target.scale.x * factor, y: target.scale.y * factor, z: target.scale.z * factor };
              applied++;
            }
            break;
          }
          case 'move': {
            const target = findTarget(next, c.target);
            if (target) {
              if (c.params.position && typeof c.params.position === 'object') {
                target.position = { ...target.position, ...(c.params.position as object) } as SceneObject['position'];
              } else if (typeof c.params.hint === 'string' && c.params.hint.includes('left')) {
                target.position = { ...target.position, x: target.position.x - 1.5 };
              } else if (typeof c.params.hint === 'string' && c.params.hint.includes('right')) {
                target.position = { ...target.position, x: target.position.x + 1.5 };
              }
              applied++;
            }
            break;
          }
          case 'rotate': {
            const target = findTarget(next, c.target);
            if (target) {
              target.rotationY = target.rotationY + (typeof c.params.degrees === 'number' ? c.params.degrees : 15);
              applied++;
            }
            break;
          }
          case 'recolor': {
            const targetHex = typeof c.params.targetAverageHex === 'string' ? c.params.targetAverageHex : undefined;
            if (targetHex) {
              const key = typeof c.target === 'string' && c.target.includes('material') ? undefined : undefined;
              void key;
              for (const m of next.materials) {
                if (m.kind === 'building' || m.kind === 'standard') m.colorHex = mixHex(m.colorHex, targetHex, 0.25);
              }
              applied++;
            }
            break;
          }
          case 'relight': {
            next.lighting = applyLightingCorrection(next.lighting, c.params);
            needLighting = true;
            applied++;
            break;
          }
          case 'recamera': {
            next.camera = applyCameraCorrection(next.camera, c.params);
            needCamera = true;
            applied++;
            break;
          }
          case 'adjust_fog': {
            if (typeof c.params.fog === 'boolean') next.lighting.fogEnabled = c.params.fog;
            if (typeof c.params.fogDensity === 'number') next.lighting.fogDensity = c.params.fogDensity;
            needLighting = true;
            applied++;
            break;
          }
          case 'adjust_terrain': {
            const terrain = next.objects.find((o) => o.category === 'terrain');
            if (terrain) {
              if (typeof c.params.widthFactor === 'number') terrain.scale.x *= c.params.widthFactor;
              if (typeof c.params.heightOffset === 'number') terrain.position.y += c.params.heightOffset;
              applied++;
            }
            break;
          }
          case 'add_object': {
            if (c.target.includes('vegetation') && !next.objects.some((o) => o.id === 'vegetation_extra')) {
              next.objects.push({
                id: 'vegetation_extra',
                name: 'Vegetation_Extra',
                category: 'vegetation',
                type: 'tree',
                position: { x: 5, y: 0, z: -16 },
                rotationY: 0,
                scale: { x: 1, y: 4.5, z: 1 },
                importance: 0.5,
                confidence: 0.4,
                notes: `added by correction iteration ${iteration}`,
              });
              applied++;
            }
            break;
          }
          case 'remove_object': {
            const idx = next.objects.findIndex((o) => o.id === c.target || o.name === c.target);
            if (idx >= 0 && next.objects[idx].category === 'vegetation' && next.objects.filter((o) => o.category === 'vegetation').length > 1) {
              next.objects.splice(idx, 1);
              applied++;
            }
            break;
          }
          default:
            this.log.debug(`Unhandled correction action "${c.action}" — skipped.`);
        }
      } catch (err) {
        this.log.warn(`Correction ${c.action} on ${c.target} failed`, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Push changes to Unity
    try {
      if (needCamera) await this.options.pipeline.applyCamera(next);
      if (needLighting) await this.options.pipeline.applyLighting(next);
      if (applied > 0) {
        await this.options.pipeline.build(next, undefined, localPaths);
        needFullRebuild = false;
      }
      void needFullRebuild;
    } catch (err) {
      this.log.warn('Failed to push corrections to Unity', { error: err instanceof Error ? err.message : String(err) });
    }

    return { plan: next, appliedCount: applied };
  }
}

function findTarget(plan: ScenePlan, target: string): SceneObject | undefined {
  const t = target.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    plan.objects.find((o) => o.name.toLowerCase().replace(/[^a-z0-9]/g, '') === t) ??
    plan.objects.find((o) => o.id.toLowerCase().replace(/[^a-z0-9]/g, '') === t) ??
    plan.objects.find((o) => o.name.toLowerCase().includes(t) || o.id.toLowerCase().includes(t) || t.includes(o.id.toLowerCase().replace(/[^a-z0-9]/g, '')))
  );
}

function mixHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  const h = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${h(mix(pa.r, pb.r))}${h(mix(pa.g, pb.g))}${h(mix(pa.b, pb.b))}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return { r: 128, g: 128, b: 128 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
