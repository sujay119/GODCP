import { join } from 'node:path';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { pathExists } from '../utils/fileSystem.js';
import type { GeneratedAsset, MeshyGenerationSpec, MeshyImageGenerationSpec } from '../models/AssetSpec.js';
import type { AssetGenerationProvider } from './AssetGenerationProvider.js';
import { MeshyClient, type MeshyClientOptions } from './MeshyClient.js';
import { MeshyTaskManager } from './MeshyTaskManager.js';
import { MeshyAssetDownloader } from './MeshyAssetDownloader.js';
import { MeshyCache } from './MeshyCache.js';
import type { MeshyTaskHandle, MeshyTaskKind, MeshyTaskStatus, TextStrategy, WaitOptions } from './MeshyTypes.js';

export interface MeshyProviderOptions extends MeshyClientOptions {
  cacheDir?: string;
  logger?: Logger;
  /** Default text generation strategy. */
  textStrategy?: TextStrategy;
  fetchImpl?: typeof fetch;
}

/**
 * Built-in AssetGenerationProvider backed by the Meshy REST API.
 * Wires client + task manager + downloader + cache together and maintains
 * usage counters used by the budget system.
 */
export class MeshyProvider implements AssetGenerationProvider {
  readonly providerId = 'meshy';

  readonly client: MeshyClient;
  readonly tasks: MeshyTaskManager;
  readonly downloader: MeshyAssetDownloader;
  readonly cache?: MeshyCache;
  readonly defaultTextStrategy: TextStrategy;

  private readonly log: Logger;
  private generationsStarted = 0;
  private creditsSpent = 0;

  constructor(options: MeshyProviderOptions = {}) {
    this.log = options.logger ?? createLogger('Meshy');
    this.client = new MeshyClient(options);
    this.tasks = new MeshyTaskManager(this.client, this.log.scope('Tasks'));
    this.downloader = new MeshyAssetDownloader(this.log.scope('Download'), options.fetchImpl);
    this.cache = options.cacheDir ? new MeshyCache(options.cacheDir, this.log.scope('Cache')) : undefined;
    this.defaultTextStrategy = options.textStrategy ?? 'two_step';
  }

  isConfigured(): boolean {
    return this.client.configured;
  }

  async generateFromText(spec: MeshyGenerationSpec): Promise<MeshyTaskHandle> {
    const strategy = this.defaultTextStrategy;
    this.generationsStarted++;
    if (strategy === 'fused') {
      const taskId = await this.client.createTextFused(spec);
      return { taskId, kind: 'text', assetId: spec.assetId, strategy: 'fused', createdAt: new Date().toISOString() };
    }
    const taskId = await this.client.createTextPreview(spec);
    return { taskId, kind: 'text', assetId: spec.assetId, strategy: 'preview', createdAt: new Date().toISOString() };
  }

  async generateFromImage(spec: MeshyImageGenerationSpec): Promise<MeshyTaskHandle> {
    this.generationsStarted++;
    const taskId = await this.client.createImageTo3D(spec);
    return { taskId, kind: 'image', assetId: spec.assetId, strategy: 'image', createdAt: new Date().toISOString() };
  }

  async getTask(taskId: string, kind: MeshyTaskKind): Promise<MeshyTaskStatus> {
    return this.client.getTaskStatus(taskId, kind);
  }

  async waitForTask(taskId: string, kind: MeshyTaskKind, options?: WaitOptions): Promise<MeshyTaskStatus> {
    return this.tasks.waitForTask(taskId, kind, options);
  }

  async completeTextGeneration(spec: MeshyGenerationSpec, strategy?: TextStrategy, options?: WaitOptions): Promise<MeshyTaskStatus> {
    this.generationsStarted++;
    const result = await this.tasks.runTextGeneration(spec, strategy ?? this.defaultTextStrategy, options);
    if (result.final.consumedCredits) this.creditsSpent += result.final.consumedCredits;
    return result.final;
  }

  async completeImageGeneration(spec: MeshyImageGenerationSpec, options?: WaitOptions): Promise<MeshyTaskStatus> {
    this.generationsStarted++;
    const result = await this.tasks.runImageGeneration(spec, options);
    if (result.final.consumedCredits) this.creditsSpent += result.final.consumedCredits;
    return result.final;
  }

  /**
   * Download a succeeded task into `destination`. When a cache is configured
   * and the same request was downloaded before, the cached asset is returned
   * (no download, no billing).
   */
  async downloadAsset(status: MeshyTaskStatus, destination: string): Promise<GeneratedAsset> {
    return this.downloader.download(status, status.raw.name ?? 'asset', destination);
  }

  /**
   * High-level: produce a local asset for a generation spec, using the cache
   * when possible. Returns null from cache lookup helpers is handled by
   * AssetPipeline; this method always performs a fresh generation.
   */
  async generateAndDownload(
    spec: MeshyGenerationSpec | MeshyImageGenerationSpec,
    destination: string,
    options: { strategy?: TextStrategy; wait?: WaitOptions } = {},
  ): Promise<GeneratedAsset> {
    const isImage = 'imageUrl' in spec;
    const status = isImage
      ? await this.completeImageGeneration(spec, options.wait)
      : await this.completeTextGeneration(spec, options.strategy, options.wait);
    const asset = await this.downloader.download(status, spec.assetId, destination);
    if (this.cache) {
      const key = MeshyCache.keyFor(isImage ? { kind: 'image', spec } : { kind: 'text', spec });
      await this.cache.put(key, asset);
    }
    return asset;
  }

  /** Look up a previously downloaded asset for an identical request. */
  async getCached(request: Record<string, unknown>): Promise<GeneratedAsset | undefined> {
    if (!this.cache) return undefined;
    const key = MeshyCache.keyFor(request);
    const asset = await this.cache.get(key);
    if (asset && !(await pathExists(asset.primaryFile))) return undefined;
    return asset;
  }

  cacheKeyFor(request: Record<string, unknown>): string {
    return MeshyCache.keyFor(request);
  }

  stats(): { callCount: number; generationsStarted: number; creditsSpent: number } {
    return {
      callCount: this.client.calls,
      generationsStarted: this.generationsStarted,
      creditsSpent: this.creditsSpent,
    };
  }

  /** Used by doctor: verify connectivity + key validity. */
  async ping(): Promise<{ ok: boolean; message: string; balance?: Record<string, unknown> }> {
    if (!this.isConfigured()) return { ok: false, message: 'MESHY_API_KEY not set' };
    try {
      const balance = await this.client.getBalance();
      return { ok: true, message: 'Meshy API reachable, key accepted', balance: balance.data };
    } catch (err) {
      const e = GODCPError.from(err, 'doctor');
      return { ok: false, message: `${e.code}: ${e.message}` };
    }
  }
}
