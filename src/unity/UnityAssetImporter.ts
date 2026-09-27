import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { copyFileTo, pathExists } from '../utils/fileSystem.js';
import { join } from 'node:path';
import type { UnityProvider } from './UnityProvider.js';

/**
 * Imports generated asset files into the Unity project. When the Unity project
 * path is known, files are copied directly on the filesystem (reliable across
 * all Unity MCP implementations) and a refresh is requested; otherwise the
 * provider's asset.import semantic op is used.
 */
export class UnityAssetImporter {
  private readonly log: Logger;

  constructor(
    private readonly provider: UnityProvider,
    private readonly unityProjectPath: string | undefined,
    logger?: Logger,
  ) {
    this.log = logger ?? createLogger('Unity:Import');
  }

  async importModel(sourceFile: string, destUnityPath: string): Promise<string> {
    if (!(await pathExists(sourceFile))) {
      throw new GODCPError('UNITY_IMPORT_FAILED', `Source model file not found: ${sourceFile}`, { stage: 'unity_import' });
    }
    if (this.unityProjectPath) {
      const dest = join(this.unityProjectPath, destUnityPath.replace(/\//g, '\\'));
      await copyFileTo(sourceFile, dest);
      this.log.info(`Copied ${sourceFile} → ${destUnityPath}`);
      await this.provider.importAsset(sourceFile, destUnityPath).catch((err) => {
        this.log.warn('Provider import op unavailable after filesystem copy (continuing)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return destUnityPath;
    }
    try {
      return await this.provider.importAsset(sourceFile, destUnityPath);
    } catch (err) {
      throw GODCPError.from(err, 'unity_import', 'UNITY_IMPORT_FAILED');
    }
  }

  async createPrefab(sourceObjectPath: string, prefabUnityPath: string): Promise<string> {
    try {
      return await this.provider.createPrefab(sourceObjectPath, prefabUnityPath);
    } catch (err) {
      throw GODCPError.from(err, 'unity_import', 'UNITY_IMPORT_FAILED');
    }
  }
}
