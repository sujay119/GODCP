import type { SceneObject } from '../models/SceneObject.js';
import type { ReferenceAnalysis } from '../models/ScenePlan.js';

export interface PromptBuildInput {
  object: SceneObject;
  analysis?: ReferenceAnalysis;
  visualStyle?: string;
}

export interface BuiltPrompt {
  prompt: string;
  texturePrompt?: string;
}

const STYLE_MODIFIER: Record<string, string> = {
  'stylized realistic': 'stylized-realistic',
  'photorealistic': 'photorealistic',
  'cartoon': 'cartoon',
  'low poly': 'low-poly',
};

/**
 * Builds optimized Meshy prompts. Raw scene descriptions are never sent —
 * prompts always enforce standalone-object constraints, correct proportions,
 * clean geometry and game-engine suitability.
 */
export class AssetPromptBuilder {
  build(input: PromptBuildInput): BuiltPrompt {
    const { object } = input;
    const style = STYLE_MODIFIER[(input.visualStyle ?? '').toLowerCase()] ?? 'stylized-realistic';

    const subject = describeSubject(object, input.analysis);
    const constraints = [
      'Standalone single object',
      'correct real-world proportions',
      'clean topology, game-ready',
      'suitable for a real-time Unity environment',
      'isolated object on a plain background',
      'no background geometry',
      'no duplicate objects',
      'no people',
      'upright orientation, origin at object base',
    ];

    const prompt = `${style} ${subject}, ${constraints.join(', ')}.`.replace(/\s+/g, ' ').slice(0, 800);

    const texturePrompt = `${style} ${describeSurface(object, input.analysis)}, consistent texel density, PBR-ready surface detail, no baked-in shadows, no background elements.`
      .replace(/\s+/g, ' ')
      .slice(0, 800);

    return { prompt, texturePrompt };
  }
}

function describeSubject(object: SceneObject, analysis?: ReferenceAnalysis): string {
  const style = analysis?.visualStyle ? `${analysis.visualStyle} ` : '';
  const envHint = analysis ? `${analysis.environmentType} ` : '';
  switch (object.category) {
    case 'building':
      return `${style}${envHint}multi-story building facade, weathered urban architecture, detailed windows and door, authentic structural proportions`;
    case 'vegetation':
      return object.type.toLowerCase().includes('bush')
        ? `${style}leafy bush shrub, natural branching, dense foliage cluster`
        : `${style}deciduous tree with full canopy, natural trunk, detailed branch structure`;
    case 'vehicle':
      return `${style}street car vehicle, complete body with wheels, windows and lights, authentic proportions`;
    case 'prop':
      return `${style}${object.type.replace(/_/g, ' ')} street prop, detailed, authentic proportions`;
    case 'character':
      return `${style}human character in relaxed standing pose, a-pose proportions`;
    case 'water':
      return `${style}water surface patch, calm reflective water`;
    default:
      return `${style}${object.type.replace(/_/g, ' ')}`;
  }
}

function describeSurface(object: SceneObject, analysis?: ReferenceAnalysis): string {
  const palette = analysis?.colors?.dominant?.slice(0, 3).join(', ');
  switch (object.category) {
    case 'building':
      return `weathered painted concrete/metal facade${palette ? ` in tones of ${palette}` : ''}`;
    case 'vegetation':
      return 'natural green foliage with subtle color variation';
    case 'vehicle':
      return 'glossy automotive paint with realistic wear';
    case 'prop':
      return `painted metal/plastic surface with light weathering${palette ? `, palette ${palette}` : ''}`;
    default:
      return 'realistic surface material with subtle wear';
  }
}

export const defaultPromptBuilder = new AssetPromptBuilder();
