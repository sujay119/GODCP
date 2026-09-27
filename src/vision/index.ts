import type { GODCPConfig } from '../config.js';
import type { VisionProvider } from './VisionProvider.js';
import { HeuristicVisionProvider } from './HeuristicVisionProvider.js';
import { OpenAICompatVisionProvider } from './OpenAICompatVisionProvider.js';
import { ReferenceAnalyzer } from './ReferenceAnalyzer.js';
import { SceneComparator } from './SceneComparator.js';
import { detectHeuristicDifferences } from './DifferenceDetector.js';

export * from './VisionProvider.js';
export { HeuristicVisionProvider } from './HeuristicVisionProvider.js';
export { OpenAICompatVisionProvider } from './OpenAICompatVisionProvider.js';
export { ReferenceAnalyzer } from './ReferenceAnalyzer.js';
export { SceneComparator } from './SceneComparator.js';
export { detectHeuristicDifferences, type DiffContext } from './DifferenceDetector.js';
export { loadImageStats, isPng, rgbToHex, colorDistance, type ImageStats } from './imageStats.js';

export function createVisionProvider(config: GODCPConfig): VisionProvider {
  if (config.vision.provider === 'openai') {
    return new OpenAICompatVisionProvider({
      apiKey: config.vision.apiKey,
      baseUrl: config.vision.baseUrl,
      model: config.vision.model,
    });
  }
  // heuristic is the safe offline default
  return new HeuristicVisionProvider();
}
