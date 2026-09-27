import type { UnityProvider, TransformSpec, PrimitiveKind } from './UnityProvider.js';

export class UnityGameObjectManager {
  constructor(private readonly provider: UnityProvider) {}
  async createEmpty(path: string) { await this.provider.createEmpty(path); }
  async createPrimitive(kind: PrimitiveKind, path: string, transform: TransformSpec) { await this.provider.createPrimitive(kind, path, transform); }
  async setTransform(path: string, t: TransformSpec) { await this.provider.setTransform(path, t); }
  async duplicate(path: string, newPath: string) { await this.provider.duplicate(path, newPath); }
  async delete(path: string) { await this.provider.delete(path); }
  async group(childPaths: string[], parentPath: string) {
    await this.provider.createEmpty(parentPath);
    for (const c of childPaths) await this.provider.setParent(c, parentPath);
  }
  async inspect(path: string) { return this.provider.inspectObject(path); }
  async instantiate(assetPath: string, name: string, t: TransformSpec, parent?: string) {
    return this.provider.instantiate(assetPath, name, t, parent);
  }
}
