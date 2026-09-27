import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { copyFileTo, ensureDir, pathExists, readJson, tryReadJson, writeJson, writeText } from '../utils/fileSystem.js';
import { referenceAnalysisSchema, scenePlanSchema, type ReferenceAnalysis, type ScenePlan } from '../models/ScenePlan.js';
import { assetManifestSchema, type AssetManifest } from '../models/AssetSpec.js';
import { buildReportSchema, buildStateSchema, iterationRecordSchema, type BuildReport, type BuildState, type IterationRecord } from '../models/BuildReport.js';
import { comparisonResultSchema, type ComparisonResult } from '../models/ComparisonResult.js';

export interface ProjectPaths {
  dir: string;
  reference: string;
  referenceImage: string;
  referenceAnalysis: string;
  scenePlan: string;
  assetManifest: string;
  buildState: string;
  comparisonHistory: string;
  report: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';
}

/**
 * Persistent per-project state. Every pipeline stage writes its artifact here
 * so an interrupted build can be resumed and audited.
 *
 * state/projects/<slug>/
 *   reference.json  reference-analysis.json  scene-plan.json
 *   asset-manifest.json  build-state.json  comparison-history.json
 *   iteration-01.json …  report.json
 */
export class ProjectState {
  readonly project: string;
  readonly paths: ProjectPaths;
  private readonly log: Logger;

  constructor(stateDir: string, project: string, logger?: Logger) {
    this.project = slugify(project);
    const dir = join(stateDir, 'projects', this.project);
    this.paths = {
      dir,
      reference: join(dir, 'reference.json'),
      referenceImage: join(dir, 'reference-image.txt'),
      referenceAnalysis: join(dir, 'reference-analysis.json'),
      scenePlan: join(dir, 'scene-plan.json'),
      assetManifest: join(dir, 'asset-manifest.json'),
      buildState: join(dir, 'build-state.json'),
      comparisonHistory: join(dir, 'comparison-history.json'),
      report: join(dir, 'report.json'),
    };
    this.log = logger ?? createLogger('ProjectState');
  }

  iterationPath(iteration: number): string {
    return join(this.paths.dir, `iteration-${String(iteration).padStart(2, '0')}.json`);
  }

  async init(input: { referenceImage: string; sceneName: string; unityProject?: string; dryRun?: boolean }): Promise<BuildState> {
    await ensureDir(this.paths.dir);
    const now = new Date().toISOString();
    const existing = await this.loadState();
    if (existing) {
      this.log.debug('Resuming existing project state', { project: this.project, stage: existing.stage });
      return existing;
    }
    const state: BuildState = buildStateSchema.parse({
      project: this.project,
      sceneName: input.sceneName,
      referenceImage: input.referenceImage,
      unityProject: input.unityProject,
      createdAt: now,
      updatedAt: now,
      stage: 'init',
      completedStages: [],
      dryRun: input.dryRun ?? false,
    });
    await writeJson(this.paths.reference, {
      project: this.project,
      referenceImage: input.referenceImage,
      sceneName: input.sceneName,
      unityProject: input.unityProject,
      createdAt: now,
    });
    await writeText(this.paths.referenceImage, input.referenceImage);
    await this.saveState(state);
    return state;
  }

  /** Wipe all persisted artifacts for this project (forces a fresh build). */
  async reset(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    if (await pathExists(this.paths.dir)) {
      await rm(this.paths.dir, { recursive: true, force: true });
      this.log.debug('Reset project state', { project: this.project });
    }
    await ensureDir(this.paths.dir);
  }

  async loadState(): Promise<BuildState | undefined> {
    const raw = await tryReadJson<unknown>(this.paths.buildState);
    if (!raw) return undefined;
    const parsed = buildStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GODCPError('STATE_FAILED', `Corrupt build-state.json: ${parsed.error.issues[0]?.message}`, {
        stage: 'state',
        details: { file: this.paths.buildState },
      });
    }
    return parsed.data;
  }

  async saveState(state: BuildState): Promise<void> {
    const updated: BuildState = { ...state, updatedAt: new Date().toISOString() };
    await writeJson(this.paths.buildState, updated);
  }

  /** Mark a named stage complete (idempotent) and persist. */
  async markStage(state: BuildState, stage: BuildState['stage']): Promise<BuildState> {
    const next: BuildState = {
      ...state,
      stage,
      completedStages: state.completedStages.includes(stage) ? state.completedStages : [...state.completedStages, stage],
      updatedAt: new Date().toISOString(),
    };
    await this.saveState(next);
    return next;
  }

  hasCompleted(state: BuildState, stage: string): boolean {
    return state.completedStages.includes(stage);
  }

  async saveAnalysis(analysis: ReferenceAnalysis): Promise<void> {
    const parsed = referenceAnalysisSchema.parse(analysis);
    await writeJson(this.paths.referenceAnalysis, parsed);
  }

  async loadAnalysis(): Promise<ReferenceAnalysis | undefined> {
    const raw = await tryReadJson<unknown>(this.paths.referenceAnalysis);
    if (!raw) return undefined;
    const parsed = referenceAnalysisSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  async savePlan(plan: ScenePlan): Promise<void> {
    const parsed = scenePlanSchema.parse(plan);
    await writeJson(this.paths.scenePlan, parsed);
  }

  async loadPlan(): Promise<ScenePlan | undefined> {
    const raw = await tryReadJson<unknown>(this.paths.scenePlan);
    if (!raw) return undefined;
    const parsed = scenePlanSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GODCPError('PLAN_VALIDATION_FAILED', `Stored scene plan is invalid: ${parsed.error.issues[0]?.message}`, { stage: 'planning' });
    }
    return parsed.data;
  }

  async saveManifest(manifest: AssetManifest): Promise<void> {
    const parsed = assetManifestSchema.parse(manifest);
    await writeJson(this.paths.assetManifest, parsed);
  }

  async loadManifest(): Promise<AssetManifest | undefined> {
    const raw = await tryReadJson<unknown>(this.paths.assetManifest);
    if (!raw) return undefined;
    const parsed = assetManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GODCPError('MANIFEST_INVALID', `Stored asset manifest is invalid: ${parsed.error.issues[0]?.message}`, { stage: 'manifest' });
    }
    return parsed.data;
  }

  async saveIteration(record: IterationRecord): Promise<void> {
    const parsed = iterationRecordSchema.parse(record);
    await writeJson(this.iterationPath(parsed.iteration), parsed);
  }

  async loadIterations(): Promise<IterationRecord[]> {
    const { readdir } = await import('node:fs/promises');
    if (!(await pathExists(this.paths.dir))) return [];
    const files = await readdir(this.paths.dir);
    const records: IterationRecord[] = [];
    for (const f of files.filter((n) => /^iteration-\d+\.json$/.test(n)).sort()) {
      const raw = await tryReadJson<unknown>(join(this.paths.dir, f));
      const parsed = iterationRecordSchema.safeParse(raw);
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  }

  async appendComparison(comparison: ComparisonResult): Promise<void> {
    const parsed = comparisonResultSchema.parse(comparison);
    const history = (await tryReadJson<{ comparisons: ComparisonResult[] }>(this.paths.comparisonHistory)) ?? { comparisons: [] };
    history.comparisons.push(parsed);
    await writeJson(this.paths.comparisonHistory, history);
  }

  async loadComparisonHistory(): Promise<ComparisonResult[]> {
    const raw = await tryReadJson<{ comparisons: ComparisonResult[] }>(this.paths.comparisonHistory);
    return raw?.comparisons ?? [];
  }

  async saveReport(report: BuildReport): Promise<void> {
    const parsed = buildReportSchema.parse(report);
    await writeJson(this.paths.report, parsed);
  }

  async loadReport(): Promise<BuildReport | undefined> {
    const raw = await tryReadJson<unknown>(this.paths.report);
    if (!raw) return undefined;
    const parsed = buildReportSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  /** Copy the reference image into project state for auditability. */
  async archiveReferenceImage(sourcePath: string): Promise<string> {
    const ext = extname(sourcePath) || '.png';
    const dest = join(this.paths.dir, `reference${ext}`);
    await copyFileTo(sourcePath, dest);
    return dest;
  }

  async exists(): Promise<boolean> {
    return pathExists(this.paths.buildState);
  }

  get name(): string {
    return basename(this.paths.dir);
  }
}
