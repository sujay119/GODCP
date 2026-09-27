import { describe, expect, it, vi } from 'vitest';
import { MeshyClient } from '../src/meshy/MeshyClient.js';
import { GODCPError } from '../src/utils/errors.js';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('MeshyClient', () => {
  it('sends bearer auth and parses start-task 202 payload', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ result: 'task-123' }, 202));
    const client = new MeshyClient({ apiKey: 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const id = await client.createTextPreview({ prompt: 'a red brick house', assetId: 'house_a' } as never);
    expect(id).toBe('task-123');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v2/text-to-3d');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
  });

  it('maps 401 to MESHY_AUTH_INVALID', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ message: 'Invalid API key' }, 401));
    const client = new MeshyClient({ apiKey: 'bad', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.createTextPreview({ prompt: 'x', assetId: 'x' } as never)).rejects.toMatchObject({ code: 'MESHY_AUTH_INVALID' });
  });

  it('maps 402 to MESHY_INSUFFICIENT_CREDITS', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ message: 'No credits' }, 402));
    const client = new MeshyClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.createTextPreview({ prompt: 'x', assetId: 'x' } as never)).rejects.toMatchObject({ code: 'MESHY_INSUFFICIENT_CREDITS' });
  });

  it('maps 429 to MESHY_RATE_LIMIT (retryable)', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ message: 'slow down' }, 429));
    const client = new MeshyClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await client.createTextPreview({ prompt: 'x', assetId: 'x' } as never).catch((e) => e);
    expect(err).toBeInstanceOf(GODCPError);
    expect(err.code).toBe('MESHY_RATE_LIMIT');
    expect(err.retryable).toBe(true);
  });

  it('normalizes task status from GET /v2/text-to-3d/{id}', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ id: 't1', status: 'IN_PROGRESS', progress: 42, task_error: null }));
    const client = new MeshyClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const status = await client.getTaskStatus('t1', 'text');
    expect(status.status).toBe('IN_PROGRESS');
    expect(status.progress).toBe(42);
    expect(fetchImpl.mock.calls[0][0]).toContain('/v2/text-to-3d/t1');
  });

  it('propagates task_error on FAILED tasks', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ id: 't2', status: 'FAILED', progress: 10, task_error: { message: 'prompt rejected' } }),
    );
    const client = new MeshyClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const status = await client.getTaskStatus('t2', 'text');
    expect(status.status).toBe('FAILED');
    expect(status.taskError?.message).toContain('prompt rejected');
  });
});
