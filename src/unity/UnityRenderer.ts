import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { pathExists } from '../utils/fileSystem.js';
import type { UnityProvider } from './UnityProvider.js';

/** Captures a preview render (screenshot) of the current Unity view. */
export class UnityRenderer {
  private readonly log: Logger;

  constructor(private readonly provider: UnityProvider, logger?: Logger) {
    this.log = logger ?? createLogger('Unity:Render');
  }

  async render(destAbsPath: string): Promise<string> {
    try {
      const out = await this.provider.captureScreenshot(destAbsPath);
      if (!(await pathExists(out))) {
        throw new GODCPError('UNITY_RENDER_UNAVAILABLE', `Screenshot tool returned success but file missing: ${out}`, { stage: 'unity_render' });
      }
      this.log.info(`Rendered preview → ${out}`);
      return out;
    } catch (err) {
      const e = GODCPError.from(err, 'unity_render', 'UNITY_RENDER_UNAVAILABLE');
      if (e.code === 'UNITY_OPERATION_FAILED') {
        throw new GODCPError('UNITY_RENDER_UNAVAILABLE', `Unity could not capture a screenshot: ${e.message}`, {
          stage: 'unity_render',
          retryable: false,
          details: e.details,
          cause: err,
        });
      }
      throw e;
    }
  }
}
