import { mkdir, readFile, rename, rm, stat, writeFile, readdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

export function resolveFrom(base: string, path: string): string {
  return resolve(base, path);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export async function tryReadJson<T = unknown>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch {
    return undefined;
  }
}

/** Atomic JSON write (write temp file, then rename) to survive crashes. */
export async function writeJson(path: string, value: unknown, pretty = true): Promise<void> {
  await ensureDir(dirname(path));
  const data = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, 'utf8');
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function copyFileTo(src: string, dest: string): Promise<void> {
  await ensureDir(dirname(dest));
  await copyFile(src, dest);
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Recursively list files under a directory (absolute paths), skipping node_modules. */
export async function listFilesRecursive(dir: string, extensions?: string[]): Promise<string[]> {
  const out: string[] = [];
  if (!(await isDirectory(dir))) return out;
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (!extensions || extensions.some((ext) => entry.name.toLowerCase().endsWith(ext.toLowerCase()))) {
          out.push(full);
        }
      }
    }
  };
  await walk(dir);
  return out;
}
