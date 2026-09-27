import { describe, expect, it } from 'vitest';
import { PROFILES, buildToolArgs, resolveToolCall, type MappingProfile } from '../src/unity/toolMapping.js';

const mcpForUnityTools = {
  manage_scene: { type: 'object', properties: { action: { type: 'string' }, sceneName: { type: 'string' } } },
  manage_gameobject: { type: 'object', properties: { action: { type: 'string' }, targetPath: { type: 'string' }, position: { type: 'object' } } },
  manage_asset: { type: 'object', properties: { action: { type: 'string' }, sourcePath: { type: 'string' }, targetPath: { type: 'string' } } },
  manage_camera: { type: 'object', properties: { action: { type: 'string' }, position: { type: 'object' } } },
};

const discovered = new Map(Object.entries(mcpForUnityTools));

describe('toolMapping', () => {
  it('resolves scene.create against the mcpforunity profile', () => {
    const call = resolveToolCall(PROFILES.mcpforunity, 'scene.create', discovered, { sceneName: 'MyScene', name: 'MyScene' });
    expect(call).toBeDefined();
    expect(call!.tool).toBe('manage_scene');
    expect(call!.arguments.sceneName).toBe('MyScene');
  });

  it('resolves object.createPrimitive via schema-driven args', () => {
    const call = resolveToolCall(PROFILES.mcpforunity, 'object.primitive', discovered, {
      targetPath: 'Root/Cube',
      primitiveType: 'cube',
      position: { x: 1, y: 2, z: 3 },
    });
    expect(call).toBeDefined();
    expect(call!.tool).toBe('manage_gameobject');
    expect(call!.arguments.action).toBeTruthy();
    expect(call!.arguments.targetPath).toBe('Root/Cube');
  });

  it('buildToolArgs passes args through when no schema is advertised', () => {
    const args = buildToolArgs('anything', undefined, { foo: 'bar' }, 'custom_action');
    expect(args.foo).toBe('bar');
    expect(args.action).toBe('custom_action');
  });

  it('buildToolArgs filters to schema properties when a schema exists', () => {
    const args = buildToolArgs('manage_scene', mcpForUnityTools.manage_scene, { sceneName: 'A', bogus: 1 }, 'open');
    expect(args.sceneName).toBe('A');
    expect(args.action).toBe('open');
    expect(args.bogus).toBeUndefined();
  });

  it('fuzzy-resolves unknown tool names', () => {
    const fuzzyOnly = new Map<string, undefined>([['Unity.ManageScene.Create', undefined]]);
    const call = resolveToolCall(PROFILES['unity-official'], 'scene.create', fuzzyOnly, { sceneName: 'S' });
    expect(call).toBeDefined();
    expect(call!.tool).toBe('Unity.ManageScene.Create');
  });

  it('returns undefined when nothing matches', () => {
    const call = resolveToolCall({} as MappingProfile, 'scene.create', new Map(), {});
    expect(call).toBeUndefined();
  });
});
