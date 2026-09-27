import type { UnityProvider } from './UnityProvider.js';

export class UnitySceneManager {
  constructor(private readonly provider: UnityProvider) {}
  async create(name: string) { await this.provider.createScene(name); }
  async open(name: string) { await this.provider.openScene(name); }
  async save() { await this.provider.saveScene(); }
  async hierarchy() { return this.provider.getHierarchy(); }
}
