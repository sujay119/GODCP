import { pathExists } from '../utils/fileSystem.js';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import type { ReferenceAnalysis } from '../models/ScenePlan.js';
import type { ComparisonResult } from '../models/ComparisonResult.js';
import type { AnalyzeImageInput, CompareImagesInput, VisionProvider } from './VisionProvider.js';
import { colorDistance, loadImageStats, rgbToHex, type ImageStats } from './imageStats.js';
import { detectHeuristicDifferences } from './DifferenceDetector.js';

const log: Logger = createLogger('Vision:Heuristic');

/**
 * Offline vision provider. Reads PNG pixels to extract brightness layout,
 * dominant colors and coarse structure (sky/ground split, road-like bands,
 * green vegetation patches, dark vertical structures). Confidence is kept
 * deliberately low — heuristic analysis is never presented as exact.
 */
export class HeuristicVisionProvider implements VisionProvider {
  readonly providerId = 'heuristic';
  readonly supportsComparison = true;

  async analyzeImage(input: AnalyzeImageInput): Promise<ReferenceAnalysis> {
    const { imagePath } = input;
    if (!(await pathExists(imagePath))) {
      throw new GODCPError('VISION_INVALID_IMAGE', `Reference image not found: ${imagePath}`, { stage: 'vision' });
    }
    const warnings: string[] = ['Heuristic (offline) analysis — geometric estimates are approximate.'];
    let stats: ImageStats;
    try {
      stats = await loadImageStats(imagePath);
    } catch (err) {
      if (err instanceof GODCPError && err.code === 'VISION_INVALID_IMAGE') {
        // Non-PNG: degrade gracefully with metadata-only analysis.
        return this.metadataOnly(imagePath, err.message);
      }
      throw err;
    }

    const { grid, rows, cols, brightness, average, dominant } = stats;
    const cell = (gx: number, gy: number) => grid[gy * cols + gx];

    // Sky vs ground split: find the first row from top whose cells stop looking sky-like.
    let horizonRow = Math.floor(rows / 2);
    for (let gy = 0; gy < rows; gy++) {
      let skyCells = 0;
      for (let gx = 0; gx < cols; gx++) {
        const c = cell(gx, gy);
        if (c.b > c.r + 8 && brightnessOf(c) > 90) skyCells++;
      }
      if (skyCells <= Math.floor(cols / 2)) { horizonRow = gy; break; }
    }

    // Road: bottom-center dark, low-saturation cells.
    const bottomRow = rows - 1;
    let roadCells = 0;
    for (let gx = Math.floor(cols / 4); gx < Math.ceil((3 * cols) / 4); gx++) {
      const c = cell(gx, bottomRow);
      const sat = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      if (brightnessOf(c) < 110 && sat < 40) roadCells++;
    }
    const road = roadCells >= 2;

    // Vegetation: green-dominant cells.
    let greenCells = 0;
    const greenCellsList: Array<{ gx: number; gy: number }> = [];
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const c = cell(gx, gy);
        if (c.g > c.r + 12 && c.g > c.b + 12 && brightnessOf(c) > 40) {
          greenCells++;
          greenCellsList.push({ gx, gy });
        }
      }
    }
    const vegetation = greenCells >= 2;

    // Buildings: tall dark/neutral structures flanking the frame (columns whose
    // cells differ strongly from sky and extend from horizon upward).
    const leftEdge = colsAtColumn(cell, 0, rows, stats);
    const rightEdge = colsAtColumn(cell, cols - 1, rows, stats);
    const buildings = leftEdge || rightEdge;

    const timeOfDay = average.r > average.b + 18 ? 'golden_hour' : brightness < 80 ? 'night' : 'day';
    const intensityHint = brightness < 70 ? 'dim' : brightness > 165 ? 'bright' : 'normal';

    const objects: ReferenceAnalysis['objects'] = [];
    if (buildings) {
      if (leftEdge) objects.push({ name: 'building_left', type: 'building', importance: 0.9, confidence: 0.5, estimatedPosition: { x: -8, y: 8, z: -15 }, estimatedScale: { x: 8, y: 16, z: 8 }, notes: 'detected dark vertical structure on the left edge' });
      if (rightEdge) objects.push({ name: 'building_right', type: 'building', importance: 0.9, confidence: 0.5, estimatedPosition: { x: 8, y: 8, z: -15 }, estimatedScale: { x: 8, y: 16, z: 8 }, notes: 'detected dark vertical structure on the right edge' });
    }
    if (road) objects.push({ name: 'road', type: 'road', importance: 0.85, confidence: 0.55, estimatedPosition: { x: 0, y: 0, z: -10 }, estimatedScale: { x: 8, y: 0.1, z: 60 }, notes: 'dark low-saturation band along the bottom center' });
    if (vegetation) {
      const first = greenCellsList[0];
      objects.push({ name: 'vegetation_cluster', type: 'vegetation', importance: 0.6, confidence: 0.5, estimatedPosition: { x: first ? gridToX(first.gx, cols) : -4, y: 2, z: -12 }, estimatedScale: { x: 4, y: 4, z: 4 }, notes: `${greenCells} green-dominant regions detected` });
    }
    if (objects.length === 0) {
      objects.push({ name: 'ground_plane', type: 'terrain', importance: 1, confidence: 0.6, estimatedPosition: { x: 0, y: 0, z: 0 }, estimatedScale: { x: 120, y: 0.1, z: 120 } });
      warnings.push('No strong structures detected — analysis defaults to an open ground plane.');
    }

    return {
      schemaVersion: '1.0',
      sourceImage: imagePath,
      environmentType: road ? 'urban street' : buildings ? 'urban environment' : vegetation ? 'natural environment' : 'open environment',
      visualStyle: 'realistic',
      composition: {
        cameraPosition: { x: 0, y: 1.7, z: 8 },
        cameraDirection: { x: 0, y: 0, z: -1 },
        estimatedFov: 50,
        confidence: 0.4,
      },
      geometry: {
        terrain: 'flat',
        road,
        sidewalk: road,
        buildings,
        vegetation,
        water: false,
        vehicles: false,
        bridge: false,
      },
      objects,
      lighting: {
        timeOfDay,
        direction: { x: -0.4, y: 0.8, z: -0.3 },
        intensityHint,
        shadows: true,
        confidence: 0.45,
      },
      colors: {
        dominant: dominant.map(rgbToHex),
        accent: dominant.slice(0, 2).map(rgbToHex),
        averageHex: rgbToHex(average),
      },
      materials: buildings
        ? [{ name: 'concrete', kind: 'building', confidence: 0.4 }, { name: 'asphalt', kind: 'road', confidence: 0.45 }]
        : [{ name: 'soil', kind: 'terrain', confidence: 0.4 }],
      atmosphere: { fog: brightness < 90, haze: false, weather: 'clear', mood: timeOfDay === 'night' ? 'dark' : 'neutral' },
      compositionNotes: [
        `Horizon estimated at ${(horizonRow / rows) * 100}% from top.`,
        `Average brightness ${Math.round(brightness)}/255.`,
      ],
      confidence: 0.38,
      warnings,
    };
  }

  async compareImages(input: CompareImagesInput): Promise<ComparisonResult> {
    const ref = await loadImageStats(input.referenceImagePath);
    const render = await loadImageStats(input.renderImagePath);
    return detectHeuristicDifferences(ref, render, input.context ?? {});
  }

  private async metadataOnly(imagePath: string, reason: string): Promise<ReferenceAnalysis> {
    log.warn('Falling back to metadata-only analysis', { reason });
    return {
      schemaVersion: '1.0',
      sourceImage: imagePath,
      environmentType: 'unknown',
      visualStyle: 'unknown',
      composition: { cameraPosition: { x: 0, y: 1.7, z: 8 }, cameraDirection: { x: 0, y: 0, z: -1 }, estimatedFov: 50, confidence: 0.2 },
      geometry: { terrain: 'unknown', road: false, sidewalk: false, buildings: false, vegetation: false, water: false, vehicles: false, bridge: false },
      objects: [{ name: 'ground_plane', type: 'terrain', importance: 1, confidence: 0.3, estimatedPosition: { x: 0, y: 0, z: 0 }, estimatedScale: { x: 120, y: 0.1, z: 120 } }],
      lighting: { timeOfDay: 'day', intensityHint: 'normal', shadows: true, confidence: 0.25 },
      colors: { dominant: [], accent: [] },
      materials: [],
      atmosphere: { fog: false, haze: false, weather: 'clear', mood: 'neutral' },
      compositionNotes: [],
      confidence: 0.2,
      warnings: [`Pixel analysis unavailable: ${reason}`, 'Analysis degraded to generic defaults.'],
    };
  }
}

function brightnessOf(c: { r: number; g: number; b: number }): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

function colsAtColumn(cell: (gx: number, gy: number) => { r: number; g: number; b: number }, gx: number, rows: number, stats: ImageStats): boolean {
  let structural = 0;
  for (let gy = 0; gy < rows; gy++) {
    const c = cell(gx, gy);
    const skyLike = c.b > c.r + 8 && brightnessOf(c) > 90;
    if (!skyLike && brightnessOf(c) < 160) structural++;
  }
  return structural >= Math.ceil(rows * 0.5);
}

function gridToX(gx: number, cols: number): number {
  return ((gx / (cols - 1)) * 2 - 1) * 10;
}

export { colorDistance };
