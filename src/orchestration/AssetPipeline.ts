import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { ensureDir, pathExists } from '../utils/fileSystem.js';
import type { AssetManifest, AssetSpec, GeneratedAsset } from '../models/AssetSpec.js';
import type { AssetGenerationProvider } from '../meshy/AssetGenerationProvider.js';
import type { AssetRegistry } from '../registry/AssetRegistry.js';
import type { BudgetConfig } from '../config.js';

export interface AssetPipelineOptions {
  registry: AssetRegistry;
  provider: AssetGenerationProvider;
  budget: BudgetConfig;
  outputDir: string;
  /** Injection point for approval mode: called once with the pending list. */
  approvalFn?: (pending: Array<{ assetId: string; prompt?: string }>) => Promise<boolean>;
  logger?: Logger;
}

export interface AssetPipelineResult {
  generated: GeneratedAsset[];
  reused: Array<{ assetId: string; registryId: string; path: string; score: number }>;
  proceduralCount: number;
  primitiveCount: number;
  skipped: Array<{ assetId: string; reason: string }>;
  localPaths: Map<string, string>;
  warnings: string[];
  creditsSpent: number;
  meshyGenerationsUsed: number;
  meshyCallCount: number;
}

/**
 * Resolves the asset manifest against the registry/cache, generates only what
 * is missing through the AssetGenerationProvider (budgeted), downloads results
 * and registers them for future reuse.
 */
export class AssetPipeline {
  private readonly log: Logger;

  constructor(private readonly options: AssetPipelineOptions) {
    this.log = options.logger ?? createLogger('AssetPipeline');
  }

  async resolve(manifest: AssetManifest, state?: { meshyGenerationsUsed?: number; meshyCallCount?: number }): Promise<AssetPipelineResult> {
    const { registry, provider, budget, outputDir } = this.options;
    const warnings: string[] = [...manifest.warnings];
    const generated: GeneratedAsset[] = [];
    const reused: AssetPipelineResult['reused'] = [];
    const skipped: AssetPipelineResult['skipped'] = [];
    const localPaths = new Map<string, string>();
    let proceduralCount = 0;
    let primitiveCount = 0;
    let generationsUsed = state?.meshyGenerationsUsed ?? 0;
    let creditsSpent = 0;

    const pending: AssetSpec[] = [];

    for (const spec of manifest.assets) {
      if (spec.generationMethod === 'procedural') { proceduralCount++; continue; }
      if (spec.generationMethod === 'primitive') { primitiveCount++; continue; }
      if (spec.generationMethod === 'existing_asset' || spec.generationMethod === 'manual') {
        const entry = await registry.get(spec.id);
        if (entry && (await pathExists(entry.localPath))) {
          localPaths.set(spec.id, entry.localPath);
          reused.push({ assetId: spec.id, registryId: entry.id, path: entry.localPath, score: 1 });
        } else {
          skipped.push({ assetId: spec.id, reason: 'marked existing_asset but not found in registry' });
        }
        continue;
      }
      if (spec.generationMethod !== 'meshy_text' && spec.generationMethod !== 'meshy_image') {
        skipped.push({ assetId: spec.id, reason: `unsupported generation method ${spec.generationMethod}` });
        continue;
      }

      // 1) registry reuse (primary cost control)
      const matches = await registry.findSimilar(
        { description: `${spec.name} ${spec.prompt ?? ''} ${spec.category}`, category: spec.category, tags: [spec.category, spec.id] },
        0.45,
      );
      const match = matches[0];
      if (match && (await pathExists(match.entry.localPath))) {
        localPaths.set(spec.id, match.entry.localPath);
        reused.push({ assetId: spec.id, registryId: match.entry.id, path: match.entry.localPath, score: match.score });
        this.log.info(`Reusing existing asset "${match.entry.id}" for "${spec.id}"`, { score: Number(match.score.toFixed(2)) });
        continue;
      }

      // 2) budget gate
      if (generationsUsed >= budget.maxMeshyGenerations) {
        skipped.push({ assetId: spec.id, reason: `budget limit reached (${budget.maxMeshyGenerations} Meshy generations)` });
        warnings.push(`Asset "${spec.id}" skipped: GODCP_MAX_MESHY_GENERATIONS limit reached.`);
        continue;
      }
      pending.push(spec);
    }

    if (pending.length === 0) {
      this.log.info('No Meshy generations required.', { reused: reused.length, proceduralCount, primitiveCount });
      return { generated, reused, proceduralCount, primitiveCount, skipped, localPaths, warnings, creditsSpent, meshyGenerationsUsed: generationsUsed, meshyCallCount: provider.stats().callCount };
    }

    // 3) approval gate
    if (budget.requireGenerationApproval) {
      const fn = this.options.approvalFn;
      if (!fn) {
        throw new GODCPError('APPROVAL_REQUIRED', 'Generation approval required but no approval handler configured.', {
          stage: 'asset_generation',
          details: { pending: pending.map((p) => p.id) },
        });
      }
      const approved = await fn(pending.map((s) => ({ assetId: s.id, prompt: s.prompt })));
      if (!approved) {
        throw new GODCPError('APPROVAL_REQUIRED', 'User declined Meshy generation.', {
          stage: 'asset_generation',
          details: { pending: pending.map((p) => p.id) },
        });
      }
    }

    if (budget.dryRun) {
      warnings.push(`Dry run: ${pending.length} asset(s) would be generated via Meshy (${manifest.summary.estimatedMeshyCalls} API calls).`);
      for (const spec of pending) skipped.push({ assetId: spec.id, reason: 'dry-run' });
      this.log.warn(`Dry run — skipping ${pending.length} Meshy generations.`);
      return { generated, reused, proceduralCount, primitiveCount, skipped, localPaths, warnings, creditsSpent, meshyGenerationsUsed: generationsUsed, meshyCallCount: provider.stats().callCount };
    }

    if (!provider.isConfigured()) {
      // Degrade gracefully: plan + procedural/primitive assets still work offline.
      warnings.push(`MESHY_API_KEY not configured — ${pending.length} asset(s) will use primitive fallbacks. Set MESHY_API_KEY to generate 3D models.`);
      for (const spec of pending) skipped.push({ assetId: spec.id, reason: 'Meshy not configured (MESHY_API_KEY missing)' });
      this.log.warn(`Meshy not configured — skipping ${pending.length} generation(s); primitives will be used.`);
      return { generated, reused, proceduralCount, primitiveCount, skipped, localPaths, warnings, creditsSpent, meshyGenerationsUsed: generationsUsed, meshyCallCount: provider.stats().callCount };
    }

    // 4) cache check + generate
    for (const spec of pending) {
      if (generationsUsed >= budget.maxMeshyGenerations) {
        skipped.push({ assetId: spec.id, reason: 'budget limit reached mid-run' });
        warnings.push(`Asset "${spec.id}" skipped: Meshy generation budget exhausted mid-run.`);
        continue;
      }

      const dest = join(outputDir, spec.id);
      await ensureDir(dest);

      // request-level cache (MeshyProvider specific, duck-typed)
      const cacheable = provider as unknown as { getCached?: (req: Record<string, unknown>) => Promise<GeneratedAsset | undefined> };
      const cacheKeyReq =
        spec.generationMethod === 'meshy_image' && spec.referenceImage
          ? { kind: 'image', assetId: spec.id, image: spec.referenceImage, texturePrompt: spec.texturePrompt }
          : { kind: 'text', assetId: spec.id, prompt: spec.prompt, texturePrompt: spec.texturePrompt };
      if (cacheable.getCached) {
        const cached = await cacheable.getCached(cacheKeyReq);
        if (cached && (await pathExists(cached.primaryFile))) {
          generated.push({ ...cached, source: 'cache' });
          localPaths.set(spec.id, cached.primaryFile);
          this.log.info(`Cache hit for "${spec.id}" — no API call.`);
          continue;
        }
      }

      generationsUsed++;
      try {
        let asset: GeneratedAsset;
        if (spec.generationMethod === 'meshy_image') {
          if (!spec.referenceImage || !(await pathExists(spec.referenceImage))) {
            throw new GODCPError('VALIDATION_FAILED', `Asset "${spec.id}" requires a reference image that does not exist.`, { stage: 'asset_generation' });
          }
          const dataUri = await fileToDataUri(spec.referenceImage);
          asset = await provider.generateAndDownload({ assetId: spec.id, imageUrl: dataUri, texturePrompt: spec.texturePrompt, shouldTexture: true }, dest);
        } else {
          const prompt = spec.prompt ?? `${spec.name}, standalone object, game-ready`;
          asset = await provider.generateAndDownload({ assetId: spec.id, prompt, texturePrompt: spec.texturePrompt, targetFormats: ['glb', 'obj'] }, dest);
        }
        generated.push(asset);
        localPaths.set(spec.id, asset.primaryFile);
        creditsSpent += Number(asset.metadata.consumedCredits ?? 0);

        await registry.register({
          id: spec.id,
          source: 'meshy',
          sourceTaskId: asset.sourceTaskId,
          localPath: asset.primaryFile,
          hash: asset.hash,
          metadata: { ...asset.metadata, category: spec.category, prompt: spec.prompt },
          tags: tokenizeTags(`${spec.category} ${spec.name} ${spec.id}`),
          category: spec.category,
          description: `${spec.name} (${spec.category})`,
        });
      } catch (err) {
        const e = GODCPError.from(err, 'asset_generation');
        if (e.code === 'BUDGET_EXCEEDED' || e.retryable === false) {
          this.log.error(`Generation failed for "${spec.id}": ${e.message}`);
        }
        skipped.push({ assetId: spec.id, reason: `${e.code}: ${e.message}` });
        warnings.push(`Asset "${spec.id}" failed to generate: ${e.code}`);
        // A failed generation must not abort the whole build unless nothing else succeeded
        if (e.code === 'MESHY_NOT_CONFIGURED' || e.code === 'APPROVAL_REQUIRED') throw e;
      }
    }

    const stats = provider.stats();
    return {
      generated,
      reused,
      proceduralCount,
      primitiveCount,
      skipped,
      localPaths,
      warnings,
      creditsSpent,
      meshyGenerationsUsed: generationsUsed,
      meshyCallCount: stats.callCount,
    };
  }
}

async function fileToDataUri(path: string): Promise<string> {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const mime = ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  const buf = await readFile(path);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function tokenizeTags(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2))].slice(0, 20);
}
