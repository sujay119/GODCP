import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server/mcpServer.js';
import { TOOL_NAMES } from '../src/server/toolRegistry.js';

describe('MCP server', () => {
  it('connects and lists every GODCP tool', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    for (const t of tools.tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
    }

    await client.close();
    await server.close();
  });

  it('godcp_registry_stats returns structured JSON content', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'godcp_registry_stats', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    const payload = JSON.parse(text);
    expect(payload.registry.entries).toBeGreaterThanOrEqual(0);
    expect(payload.configured.vision).toBeTruthy();
    expect(payload.budget.maxIterations).toBeGreaterThan(0);

    await client.close();
    await server.close();
  });

  it('godcp_analyze_reference fails with a structured envelope for a missing image', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: 'godcp_analyze_reference', arguments: { referenceImage: 'definitely-missing.png' } });
    expect(result.isError).toBe(true);
    const payload = JSON.parse((result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}');
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe('VISION_INVALID_IMAGE');
    expect(payload.stage).toBe('vision');

    await client.close();
    await server.close();
  });
});
