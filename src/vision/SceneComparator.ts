import { pathExists } from '../utils/fileSystem.js';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import type { ComparisonResult } from '../models/ComparisonResult.js';
import type { VisionProvider } from './VisionProvider.js';

/** Compares a Unity render against the reference image. */
export class SceneComparator {
  private readonly log: Logger;

  constructor(private readonly provider: VisionProvider, logger?: Logger) {
    this.log = logger ?? createLogger('Comparison');
  }

  async compare(referenceImagePath: string, renderImagePath: string, context?: { sceneName?: string; objectNames?: string[]; similarityTarget?: number }): Promise<ComparisonResult> {
    for (const p of [referenceImagePath, renderImagePath]) {
      if (!(await pathExists(p))) {
        throw new GODCPError('VISION_INVALID_IMAGE', `Comparison input missing: ${p}`, { stage: 'comparison' });
      }
    }
    const result = await this.provider.compareImages({ referenceImagePath, renderImagePath, context });
    this.log.info(`Detected ${result.differences.length} major differences.`, {
      similarity: result.overallSimilarity,
      corrections: result.corrections.length,
      method: result.method,
    });
    return result;
  }
}
