import type { UnityProvider, MaterialSpecInput } from './UnityProvider.js';

export class UnityMaterialManager {
  constructor(private readonly provider: UnityProvider) {}
  async set(targetPath: string, material: MaterialSpecInput) { await this.provider.setMaterial(targetPath, material); }
  async setColor(targetPath: string, colorHex: string) { await this.provider.setMaterial(targetPath, { colorHex }); }
}
