import { pathExists } from '../utils/fileSystem.js';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import type { ReferenceAnalysis } from '../models/ScenePlan.js';
import type { VisionProvider } from './VisionProvider.js';

const SUPPORTED = ['.png', '.jpg', '.jpeg', '.webp'];

/** Validates reference images and delegates analysis to the configured VisionProvider. */
export class ReferenceAnalyzer {
  private readonly log: Logger;

  constructor(private readonly provider: VisionProvider, logger?: Logger) {
    this.log = logger ?? createLogger('ReferenceAnalyzer');
  }

  async analyze(imagePath: string, hints?: string[]): Promise<ReferenceAnalysis> {
    if (!imagePath || !(await pathExists(imagePath))) {
      throw new GODCPError('VISION_INVALID_IMAGE', `Reference image not found: ${imagePath}`, { stage: 'vision' });
    }
    const ext = imagePath.slice(imagePath.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED.includes(ext)) {
      throw new GODCPError('VISION_INVALID_IMAGE', `Unsupported reference image type "${ext}" (supported: ${SUPPORTED.join(', ')})`, { stage: 'vision' });
    }
    this.log.info(`Analyzing reference image via "${this.provider.providerId}" provider`, { imagePath });
    const analysis = await this.provider.analyzeImage({ imagePath, hints });
    this.log.info(`Analysis complete (confidence ${analysis.confidence})`, {
      environmentType: analysis.environmentType,
      objects: analysis.objects.length,
    });
    return analysis;
  }
}
