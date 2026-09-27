import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import { GODCPError } from './utils/errors.js';
import type { LogLevel } from './utils/logger.js';

loadDotenv({ quiet: true });

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const num = (fallback: number) =>
  z
    .union([z.string(), z.number(), z.undefined()])
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : fallback;
    });

const envSchema = z.object({
  // Meshy
  MESHY_API_KEY: z.string().optional(),
  MESHY_API_BASE_URL: z.string().url().default('https://api.meshy.ai/openapi'),

  // Unity MCP
  UNITY_MCP_URL: z.string().optional(),
  UNITY_MCP_COMMAND: z.string().optional(),
  UNITY_MCP_PORT: num(8080).optional(),
  UNITY_MCP_PROFILE: z.enum(['mcpforunity', 'unity-official', 'generic', 'mock']).default('generic'),
  UNITY_PROJECT_PATH: z.string().optional(),

  // Paths
  GODCP_ASSET_DIR: z.string().default('./assets/generated'),
  GODCP_CACHE_DIR: z.string().default('./assets/cache'),
  GODCP_RENDER_DIR: z.string().default('./assets/renders'),
  GODCP_STATE_DIR: z.string().default('./state'),
  GODCP_REFERENCE_DIR: z.string().default('./assets/references'),

  // Vision
  VISION_PROVIDER: z.enum(['heuristic', 'openai', 'mock']).default('heuristic'),
  VISION_API_KEY: z.string().optional(),
  VISION_BASE_URL: z.string().default('https://api.openai.com/v1'),
  VISION_MODEL: z.string().default('gpt-4o-mini'),

  // Runtime
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['text', 'json']).default('text'),
  GODCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  GODCP_HTTP_PORT: num(3100),

  // Cost / safety
  GODCP_MAX_MESHY_GENERATIONS: num(20),
  GODCP_MAX_MESHY_CALLS: num(60),
  GODCP_MAX_ITERATIONS: num(3),
  GODCP_DRY_RUN: boolish.default(false),
  GODCP_REQUIRE_GENERATION_APPROVAL: boolish.default(false),
  GODCP_SIMILARITY_TARGET: num(0.85),
});

export type EnvRaw = z.infer<typeof envSchema>;

export interface BudgetConfig {
  maxMeshyGenerations: number;
  maxMeshyCalls: number;
  maxIterations: number;
  dryRun: boolean;
  requireGenerationApproval: boolean;
  similarityTarget: number;
}

export interface GODCPConfig {
  meshy: {
    apiKey?: string;
    baseUrl: string;
    configured: boolean;
  };
  unity: {
    url?: string;
    command?: string;
    port?: number;
    profile: 'mcpforunity' | 'unity-official' | 'generic' | 'mock';
    projectPath?: string;
  };
  vision: {
    provider: 'heuristic' | 'openai' | 'mock';
    apiKey?: string;
    baseUrl: string;
    model: string;
  };
  paths: {
    assetDir: string;
    cacheDir: string;
    renderDir: string;
    stateDir: string;
    referenceDir: string;
  };
  transport: 'stdio' | 'http';
  httpPort: number;
  logLevel: LogLevel;
  logFormat: 'text' | 'json';
  budget: BudgetConfig;
}

function abs(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): GODCPConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new GODCPError('CONFIG_INVALID', `Invalid environment configuration: ${parsed.error.issues[0]?.message}`, {
      stage: 'config',
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  const e = parsed.data;
  return {
    meshy: {
      apiKey: e.MESHY_API_KEY || undefined,
      baseUrl: e.MESHY_API_BASE_URL.replace(/\/$/, ''),
      configured: Boolean(e.MESHY_API_KEY),
    },
    unity: {
      url: e.UNITY_MCP_URL || undefined,
      command: e.UNITY_MCP_COMMAND || undefined,
      port: e.UNITY_MCP_PORT,
      profile: e.UNITY_MCP_PROFILE,
      projectPath: e.UNITY_PROJECT_PATH ? abs(e.UNITY_PROJECT_PATH, cwd) : undefined,
    },
    vision: {
      provider: e.VISION_PROVIDER,
      apiKey: e.VISION_API_KEY || undefined,
      baseUrl: e.VISION_BASE_URL.replace(/\/$/, ''),
      model: e.VISION_MODEL,
    },
    paths: {
      assetDir: abs(e.GODCP_ASSET_DIR, cwd),
      cacheDir: abs(e.GODCP_CACHE_DIR, cwd),
      renderDir: abs(e.GODCP_RENDER_DIR, cwd),
      stateDir: abs(e.GODCP_STATE_DIR, cwd),
      referenceDir: abs(e.GODCP_REFERENCE_DIR, cwd),
    },
    transport: e.GODCP_TRANSPORT,
    httpPort: e.GODCP_HTTP_PORT,
    logLevel: e.LOG_LEVEL,
    logFormat: e.LOG_FORMAT,
    budget: {
      maxMeshyGenerations: e.GODCP_MAX_MESHY_GENERATIONS,
      maxMeshyCalls: e.GODCP_MAX_MESHY_CALLS,
      maxIterations: e.GODCP_MAX_ITERATIONS,
      dryRun: e.GODCP_DRY_RUN,
      requireGenerationApproval: e.GODCP_REQUIRE_GENERATION_APPROVAL,
      similarityTarget: e.GODCP_SIMILARITY_TARGET,
    },
  };
}

let cached: GODCPConfig | undefined;

/** Memoized process config (tests can bypass via loadConfig with explicit env). */
export function getConfig(): GODCPConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
