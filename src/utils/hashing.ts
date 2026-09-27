import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

export function sha256String(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function sha256OfExistingFile(path: string): Promise<string> {
  try {
    return await sha256File(path);
  } catch {
    const buf = await readFile(path);
    return createHash('sha256').update(buf).digest('hex');
  }
}

/** Deterministic hash of any JSON-serializable value (keys sorted). */
export function hashObject(value: unknown): string {
  return sha256String(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function shortHash(hash: string, length = 12): string {
  return hash.slice(0, length);
}
