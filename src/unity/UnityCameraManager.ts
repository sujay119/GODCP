import type { UnityProvider, CameraSpec, LightSpec, RenderSettingsSpec } from './UnityProvider.js';

export class UnityCameraManager {
  constructor(private readonly provider: UnityProvider) {}
  async configure(spec: CameraSpec) { await this.provider.configureCamera(spec); }
  async createLight(spec: LightSpec) { await this.provider.createLight(spec); }
  async setRenderSettings(settings: RenderSettingsSpec) { await this.provider.setRenderSettings(settings); }
}
