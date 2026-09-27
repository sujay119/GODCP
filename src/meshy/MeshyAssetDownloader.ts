import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { ensureDir, pathExists } from '../utils/fileSystem.js';
import { sha256File, shortHash } from '../utils/hashing.js';
import type { GeneratedAsset } from '../models/AssetSpec.js';
import type { MeshyTaskStatus } from './MeshyTypes.js';

const FORMAT_PREFERENCE = ['glb', 'fbx', 'obj', 'gltf', 'usdz'];
const TEXTURE_KEYS = ['base_color', 'metallic', 'roughness', 'normal', 'emission', 'metallic_roughness'];

export interface DownloadOptions {
  /** Preferred model formats in order. */
  formats?: string[];
  downloadTextures?: boolean;
  downloadThumbnail?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Downloads generated model + textures from signed Meshy asset URLs into a
 * local directory and computes a content hash for the registry/cache.
 */
export class MeshyAssetDownloader {
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(logger?: Logger, fetchImpl?: typeof fetch) {
    this.log = logger ?? createLogger('Meshy:Download');
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async download(task: MeshyTaskStatus, assetId: string, destination: string, options: DownloadOptions = {}): Promise<GeneratedAsset> {
    if (task.status !== 'SUCCEEDED') {
      throw new GODCPError('MESHY_DOWNLOAD_FAILED', `Cannot download from task in status ${task.status}`, {
        stage: 'meshy_download',
        retryable: false,
        details: { taskId: task.id },
      });
    }
    const formats = options.formats ?? FORMAT_PREFERENCE;
    const chosen = formats.find((f) => task.modelUrls[f]) ?? Object.keys(task.modelUrls)[0];
    const modelUrl = chosen ? task.modelUrls[chosen] : undefined;
    if (!modelUrl) {
      throw new GODCPError('MESHY_DOWNLOAD_FAILED', `Task ${task.id} produced no downloadable model URLs`, {
        stage: 'meshy_download',
        retryable: false,
        details: { taskId: task.id, available: Object.keys(task.modelUrls) },
      });
    }

    await ensureDir(destination);
    const ext = chosen ?? 'glb';
    const primaryFile = join(destination, `model.${ext}`);
    await this.fetchToFile(modelUrl, primaryFile);
    this.log.info(`Downloaded model.${ext} for "${assetId}"`, { destination });

    const files = [primaryFile];
    const textureFiles: string[] = [];

    if (options.downloadTextures !== false && task.textureUrls.length > 0) {
      const texDir = join(destination, 'textures');
      await ensureDir(texDir);
      const texSet = task.textureUrls[0];
      for (const key of TEXTURE_KEYS) {
        const url = texSet[key];
        if (!url) continue;
        const file = join(texDir, `texture_${keyToSuffix(key)}.png`);
        try {
          await this.fetchToFile(url, file);
          files.push(file);
          textureFiles.push(file);
        } catch (err) {
          this.log.warn(`Failed to download texture ${key}`, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    let thumbnailPath: string | undefined;
    if (options.downloadThumbnail !== false && task.thumbnailUrl) {
      try {
        thumbnailPath = join(destination, 'thumbnail.png');
        await this.fetchToFile(task.thumbnailUrl, thumbnailPath);
        files.push(thumbnailPath);
      } catch (err) {
        this.log.warn('Failed to download thumbnail', { error: err instanceof Error ? err.message : String(err) });
        thumbnailPath = undefined;
      }
    }

    const hash = await sha256File(primaryFile);
    const asset: GeneratedAsset = {
      assetId,
      files,
      primaryFile,
      format: ext,
      textureFiles,
      hash,
      sourceTaskId: task.id,
      source: 'meshy',
      metadata: {
        shortHash: shortHash(hash),
        consumedCredits: task.consumedCredits ?? 0,
        prompt: task.prompt,
        downloadedAt: new Date().toISOString(),
      },
    };
    return asset;
  }

  private async fetchToFile(url: string, dest: string): Promise<void> {
    const tmp = `${dest}.part`;
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok || !res.body) {
        throw new GODCPError('MESHY_DOWNLOAD_FAILED', `Download failed (${res.status}) for ${sanitize(url)}`, {
          stage: 'meshy_download',
          retryable: res.status >= 500 || res.status === 429,
          details: { status: res.status },
        });
      }
      const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      await pipeline(nodeStream, createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (err) {
      throw GODCPError.from(err, 'meshy_download', 'MESHY_DOWNLOAD_FAILED');
    }
  }
}

function keyToSuffix(key: string): string {
  return key.replace(/_/g, '');
}

function sanitize(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}
