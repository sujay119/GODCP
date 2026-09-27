# GODCP MCP — Architecture

## 1. Purpose

GODCP is an **orchestration layer** that turns a reference image of an environment
into a built, rendered, compared and iteratively corrected Unity scene — with minimal
Meshy API spend.

```
                 OpenCode / MCP Client
                         │  MCP (stdio)
                         ▼
                 ┌───────────────┐
                 │  GODCP MCP │  high-level semantic tools only
                 └───────┬───────┘
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
  Vision Planner    Meshy Adapter     Unity Adapter
  (analyze/compare) (AssetGeneration  (UnityProvider:
        │            Provider)         MCP client → Unity MCP server)
        ▼                │                 │
  ReferenceAnalysis      ▼                 ▼
  ScenePlan          Meshy REST API    Unity Editor
  AssetManifest      (tasks+polling)   (scene, objects, camera,
        │                │             lighting, screenshots)
        └────────────────┴───────┬───────┘
                                 ▼
                    EnvironmentBuilder / IterationEngine
                    (state/projects/<name>/…, resumable)
```

Design priorities, in order: **reference fidelity → low API cost → reusability →
Unity performance.**

## 2. Layering

| Layer | Directory | Responsibility |
|---|---|---|
| Transport/Server | `src/server/` | MCP server (stdio + optional HTTP), tool registry, dependency-injection context |
| Tools | `src/tools/` | Thin zod-validated MCP tool handlers; no business logic |
| Orchestration | `src/orchestration/` | `EnvironmentBuilder` (full pipeline), `AssetPipeline`, `ScenePipeline`, `IterationEngine` |
| Planning | `src/planner/` | Reference → ScenePlan → AssetManifest; camera/lighting planners; `AssetPromptBuilder` |
| Vision | `src/vision/` | `VisionProvider` abstraction, reference analysis, render↔reference comparison, pixel diff |
| Meshy | `src/meshy/` | `AssetGenerationProvider` impl: REST client, task manager, downloader, cache |
| Unity | `src/unity/` | `UnityProvider` impl: MCP client, tool-mapping profiles, scene/object/material/camera/renderer managers, mock provider |
| Registry/State | `src/registry/` | Persistent asset registry (reuse!), project state (resumable builds) |
| Models | `src/models/` | Zod schemas shared by everything (ScenePlan, AssetSpec, ComparisonResult, …) |
| Utils | `src/utils/` | Structured logger, fs helpers, hashing, validation, typed errors |
| CLI | `src/cli/` | `GODCP` commands incl. `doctor`, `demo` |
| Unity package | `unity/GODCPUnity/` | Optional Editor component: `godcp_*` custom MCP tools (screenshot/import bridge) |

## 3. Provider interfaces (extensibility)

All external systems sit behind interfaces so providers can be swapped without touching
orchestration:

```ts
interface VisionProvider {
  analyzeImage(input): Promise<ReferenceAnalysis>;
  compareImages(input): Promise<ComparisonResult>;
}

interface AssetGenerationProvider {          // src/meshy/AssetGenerationProvider.ts
  generateFromText(spec): Promise<MeshyTaskHandle>;
  generateFromImage(spec): Promise<MeshyTaskHandle>;
  getTask(id, kind): Promise<MeshyTaskStatus>;
  downloadAsset(status, destination): Promise<GeneratedAsset>;
}

interface UnityProvider {                    // src/unity/UnityProvider.ts
  // semantic ops only: createScene, getHierarchy, createGameObject, importAsset,
  // setTransform, setMaterial, createLight, configureCamera, screenshot, …
}
```

Adding Blender/Unreal/Godot/local-model generation or another vision model = one new
provider implementation + config switch.

## 4. Unity communication mechanism

GODCP is an **MCP client** toward Unity. It connects to any Unity MCP server using
the official MCP SDK client (Streamable HTTP when `UNITY_MCP_URL` is set, stdio when
`UNITY_MCP_COMMAND` is set), performs `tools/list` discovery, and resolves its semantic
operations through **mapping profiles** (`mcpforunity` | `unity-official` | `generic`):

```
EnvironmentBuilder
   → UnitySceneManager/GameObjectManager/…/Renderer   (semantic)
      → UnityProvider.resolve(op)                      (profile mapping)
         → McpUnityClient.callTool(name, args)         (MCP tools/call)
            → Unity MCP server → Unity Editor
```

Profiles live in `src/unity/toolMapping.ts`; the `generic` profile falls back to fuzzy
name matching against discovered tools. Unmapped/unavailable capabilities raise
`UNITY_TOOL_UNAVAILABLE` instead of silently no-oping.

## 5. Build pipeline (EnvironmentBuilder.build)

```
validate reference → analyze (VisionProvider) → scene plan → asset manifest
   → registry reuse lookup → procedural/primitive split → budget checks
   → Meshy generation (prompt builder → task → poll → download) → register
   → import to Unity → construct scene (terrain/road/architecture/props/…)
   → camera → lighting → materials → save scene
   → render → compare → corrections → apply → render … (≤ maxIterations)
   → BuildReport
```

Every stage persists into `state/projects/<project>/` (`reference-analysis.json`,
`scene-plan.json`, `asset-manifest.json`, `build-state.json`, `iteration-NN.json`,
`comparison-history.json`), so an interrupted build **resumes** at the last completed
stage.

## 6. Cost controls

- `dryRun` — plan + budget report, zero network writes to Meshy.
- `maxMeshyGenerations` / `maxMeshyCalls` hard caps (default 20).
- `maxIterations` (default 3) on the render/compare loop.
- Asset registry similarity search ⇒ reuse instead of regenerate.
- Request-hash cache (`assets/cache/`) ⇒ identical prompts never re-bill.
- `requireGenerationApproval` ⇒ injected approval callback per batch.
- Procedural/primitive preference: roads, sidewalks, terrain, simple boxes never hit Meshy.

## 7. Error model

Everything that fails returns a structured error (also the MCP tool error payload):

```jsonc
{ "success": false, "stage": "meshy_generation",
  "errorCode": "MESHY_RATE_LIMIT", "message": "…",
  "retryable": true, "details": { … } }
```

Typed `GODCPError` codes cover meshy (`MESHY_AUTH_INVALID`, `MESHY_RATE_LIMIT`,
`MESHY_INSUFFICIENT_CREDITS`, `MESHY_TASK_FAILED`, `MESHY_TASK_TIMEOUT`,
`MESHY_UNAVAILABLE`, `MESHY_DOWNLOAD_FAILED`), unity (`UNITY_UNAVAILABLE`,
`UNITY_MCP_UNAVAILABLE`, `UNITY_TOOL_UNAVAILABLE`, `UNITY_RENDER_UNAVAILABLE`,
`UNITY_SCENE_SAVE_FAILED`, `UNITY_IMPORT_FAILED`), vision (`VISION_INVALID_IMAGE`,
`VISION_PROVIDER_FAILED`), planning (`PLAN_VALIDATION_FAILED`, `MANIFEST_INVALID`),
and control (`BUDGET_EXCEEDED`, `APPROVAL_REQUIRED`, `TIMEOUT`, …). Exceptions are
never swallowed; every tool call ends in either data or a structured error.

## 8. Data flow example (one-shot tool)

`build_environment_from_reference` → `EnvironmentBuilder.build()` →
`BuildReport { status, scene, assetsGenerated, assetsReused, proceduralObjects,
iterations, finalRender, scenePlan, warnings[] }`.
