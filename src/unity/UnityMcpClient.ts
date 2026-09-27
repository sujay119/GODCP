import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { sleep } from '../utils/validation.js';
import {
  PROFILES,
  mergeProfileOverride,
  resolveToolCall,
  type MappingProfile,
  type ProfileId,
  type SemanticOp,
} from './toolMapping.js';

type JsonSchema = Record<string, any>;

export interface UnityMcpClientOptions {
  /** Streamable HTTP endpoint, e.g. http://localhost:8080/mcp */
  url?: string;
  /** Command line for stdio mode, e.g. path to the Unity relay binary with --mcp */
  command?: string;
  commandArgs?: string[];
  env?: Record<string, string>;
  profile?: ProfileId;
  /** JSON file overriding/extending the mapping profile. */
  toolMapOverride?: Partial<MappingProfile>;
  logger?: Logger;
  requestTimeoutMs?: number;
}

export interface ToolCallResult {
  tool: string;
  isError: boolean;
  raw: string;
  data?: unknown;
}

/**
 * MCP client for a Unity MCP server (Streamable HTTP or stdio). Wraps
 * tools/list discovery + tools/call with profile-based semantic resolution,
 * timeouts and structured errors.
 */
export class UnityMcpClient {
  private readonly options: UnityMcpClientOptions;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport | StdioClientTransport;
  private tools?: Map<string, JsonSchema | undefined>;
  private profile: MappingProfile;

  constructor(options: UnityMcpClientOptions) {
    this.options = options;
    this.log = options.logger ?? createLogger('Unity:MCP');
    this.timeoutMs = options.requestTimeoutMs ?? 30000;
    const base = PROFILES[options.profile ?? 'generic'];
    this.profile = options.toolMapOverride ? mergeProfileOverride(base, options.toolMapOverride) : base;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  get profileId(): ProfileId {
    return this.options.profile ?? 'generic';
  }

  async connect(): Promise<void> {
    if (this.client) return;
    if (!this.options.url && !this.options.command) {
      throw new GODCPError('UNITY_MCP_UNAVAILABLE', 'Unity MCP is not configured (set UNITY_MCP_URL or UNITY_MCP_COMMAND).', {
        stage: 'unity_connect',
        retryable: false,
      });
    }

    const client = new Client({ name: 'GODCP', version: '0.1.0' }, { capabilities: {} });
    try {
      if (this.options.url) {
        this.log.info(`Connecting to Unity MCP at ${this.options.url}`);
        this.transport = new StreamableHTTPClientTransport(new URL(this.options.url));
      } else {
        const [cmd, ...args] = (this.options.command ?? '').split(/\s+/);
        this.log.info(`Launching Unity MCP server: ${cmd}`);
        this.transport = new StdioClientTransport({
          command: cmd,
          args: [...args, ...(this.options.commandArgs ?? [])],
          env: { ...(this.options.env ?? {}), ...pickProcessEnv() } as Record<string, string>,
          stderr: 'pipe',
        });
      }
      await client.connect(this.transport);
      this.client = client;
    } catch (err) {
      this.transport = undefined;
      throw new GODCPError('UNITY_MCP_UNAVAILABLE', `Failed to connect to Unity MCP: ${err instanceof Error ? err.message : String(err)}`, {
        stage: 'unity_connect',
        retryable: true,
        cause: err,
      });
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      /* ignore close errors */
    }
    this.transport = undefined;
    this.client = undefined;
    this.tools = undefined;
  }

  /** Discover tools and cache name → inputSchema. */
  async listTools(force = false): Promise<Map<string, JsonSchema | undefined>> {
    if (this.tools && !force) return this.tools;
    await this.connect();
    const map = new Map<string, JsonSchema | undefined>();
    try {
      const result = await this.withTimeout(this.client!.listTools(), this.timeoutMs, 'tools/list');
      for (const tool of result.tools) {
        map.set(tool.name, (tool as { inputSchema?: JsonSchema }).inputSchema);
      }
    } catch (err) {
      throw GODCPError.from(err, 'unity_discover', 'UNITY_MCP_UNAVAILABLE');
    }
    this.log.info(`Discovered ${map.size} Unity MCP tools`, { profile: this.profileId });
    this.tools = map;
    return map;
  }

  async toolNames(): Promise<string[]> {
    return [...(await this.listTools()).keys()];
  }

  /** Low-level tools/call with structured error handling. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ToolCallResult> {
    await this.connect();
    const started = Date.now();
    let result;
    try {
      result = await this.withTimeout(
        this.client!.callTool({ name, arguments: args }),
        timeoutMs ?? this.timeoutMs,
        `tools/call ${name}`,
      );
    } catch (err) {
      throw GODCPError.from(err, 'unity_call', 'UNITY_OPERATION_FAILED');
    } finally {
      this.log.debug(`tools/call ${name} took ${Date.now() - started}ms`);
    }

    const isError = Boolean((result as { isError?: boolean }).isError);
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const textParts = content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!);
    const raw = textParts.join('\n');
    let data: unknown = (result as { structuredContent?: unknown }).structuredContent;
    if (data === undefined && raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    // Unity MCP servers commonly report {"success": false, "message": ...}
    if (data && typeof data === 'object' && 'success' in (data as any) && (data as any).success === false) {
      const message = String((data as any).message ?? 'Unity operation reported success=false');
      throw new GODCPError('UNITY_OPERATION_FAILED', `${name}: ${message}`, {
        stage: 'unity_call',
        retryable: false,
        details: { tool: name, args, upstream: data },
      });
    }
    if (isError) {
      throw new GODCPError('UNITY_OPERATION_FAILED', `${name} returned an error: ${raw.slice(0, 400)}`, {
        stage: 'unity_call',
        retryable: false,
        details: { tool: name, raw: raw.slice(0, 2000) },
      });
    }
    return { tool: name, isError, raw, data };
  }

  /**
   * Resolve a semantic operation through the active profile (+ discovery
   * fallback) and execute it. Throws UNITY_TOOL_UNAVAILABLE when no tool
   * matches — never fakes success.
   */
  async callSemantic(op: SemanticOp, opArgs: Record<string, unknown> = {}, timeoutMs?: number): Promise<ToolCallResult> {
    const tools = await this.listTools();
    const resolved = resolveToolCall(this.profile, op, tools, opArgs);
    if (!resolved) {
      throw new GODCPError(
        'UNITY_TOOL_UNAVAILABLE',
        `No Unity MCP tool available for operation "${op}" (profile: ${this.profileId}). Discovered tools: ${[...tools.keys()].slice(0, 40).join(', ')}`,
        {
          stage: 'unity_call',
          retryable: false,
          details: {
            op,
            profile: this.profileId,
            discoveredTools: [...tools.keys()],
            hint: 'Check UNITY_MCP_PROFILE, install the matching Unity MCP plugin, or provide a UNITY_MCP_TOOL_MAP override.',
          },
        },
      );
    }
    this.log.debug(`Resolved ${op} → ${resolved.tool}`, { args: resolved.arguments });
    return this.callTool(resolved.tool, resolved.arguments, timeoutMs);
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new GODCPError('TIMEOUT', `Unity MCP call timed out after ${ms}ms (${label})`, { stage: 'unity_call', retryable: true })), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function pickProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'PATHEXT', 'PYTHONPATH']) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  return out;
}

export async function retryOnUnavailable(fn: () => Promise<void>, attempts = 3, baseDelayMs = 500): Promise<void> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
      if (err instanceof GODCPError && !err.retryable) throw err;
      if (i < attempts) await sleep(baseDelayMs * i);
    }
  }
  throw lastErr;
}
