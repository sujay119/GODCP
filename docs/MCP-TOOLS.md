# MCP Tools Reference

All tools return MCP `content[0].text` containing JSON. On failure `isError: true` and the payload is the standard envelope:

```json
{ "success": false, "stage": "vision", "errorCode": "VISION_INVALID_IMAGE", "message": "…", "retryable": false, "details": {} }
```

Success payloads are also JSON (also exposed via `structuredContent`).

---

## Pipeline (one-shot)

### `godcp_build_environment_from_reference`
The full pipeline: validate → analyze → plan → manifest → registry/cache → Meshy generation (budgeted) → Unity construction → render → compare → correct loop → `BuildReport`. Resumable; a completed project returns its stored report (pass `resume:false` to force).

| Input | Type | Notes |
|---|---|---|
| `referenceImage` | string | path to the reference PNG |
| `unityProject` | string? | Unity project root (Assets parent) |
| `sceneName` | string? | default `GeneratedEnvironment` |
| `project` | string? | state slug (default from scene name) |
| `style` | string? | planning hint, e.g. `"photorealistic urban street"` |
| `maxIterations` | int 1–10? | render/compare/correct cap |
| `maxMeshyGenerations` | int? | per-call generation budget override |
| `assetQuality` | `draft\|standard\|high`? | maps to Meshy preview/refine |
| `dryRun` | bool? | plan only; no Meshy, no Unity writes |
| `resume` | bool? | default `true` |

**Output:** `BuildReport` — `{ status: completed|partial|failed|dry_run, project, scene, scenePlanPath, assetManifestPath, finalRenderPath, assetsGenerated, assetsReused, proceduralObjects, meshyCreditsSpent, iterations, finalSimilarity, durationMs, warnings[], error? }`.

---

## Reference / vision

### `godcp_analyze_reference`
Input: `{ referenceImage, hints?: string[] }` → `ReferenceAnalysis` (colors, geometry flags, lighting/time-of-day, atmosphere, detected objects with confidence, `schemaVersion`). Offline heuristic provider by default; `VISION_PROVIDER=openai` for VLM.

### `godcp_compare_images`
Input: `{ referenceImage, renderImage, similarityTarget?: number }` → `ComparisonResult` `{ overallSimilarity 0..1, differences[], corrections[{action,target,params,rationale,confidence}], summary, method: vision_llm|heuristic, warnings[] }`.

---

## Planning

### `godcp_create_scene_plan`
Input: `{ referenceImage, project?, sceneName?, style?, force? }` → analyzes (or reuses stored analysis), creates and persists a `ScenePlan`: objects (transforms, categories, importance, confidence), materials, camera, lighting, hierarchy, reuse opportunities. Returns `{ project, analysisPath, planPath, plan }`.

### `godcp_create_asset_manifest`
Input: `{ project, force? }` → persists `AssetManifest` from the stored plan: per-asset `{ generationMethod: meshy_text|meshy_image|procedural|primitive|existing_asset, prompt, objectIds, estimatedComplexity }` + summary/estimated API calls.

---

## Assets

### `godcp_generate_assets`
Input: `{ project, dryRun?, maxGenerations?, approve? }` → registry reuse → cache → budgeted Meshy generation → download → register. Output: `{ generated[], reused[], skipped[], creditsSpent, meshyGenerationsUsed, warnings[] }`. Errors with `MESHY_NOT_CONFIGURED` when a key is required but absent.

### `godcp_list_assets`
Input: `{ query?, category?, limit? }` → registry entries (id, localPath, hash, tags, category).

### `godcp_registry_stats`
Input: `{}` → `{ registry.entries, meshy: {callCount, generationsStarted, creditsSpent}, configured, budget }`.

---

## Build state

### `godcp_get_build_status`
Input: `{ project }` → `{ state: BuildState, iterations[], comparisons[], report, paths }`. `BuildState` tracks `stage`, `completedStages[]`, `iterationCount`, `meshyGenerationsUsed/CallCount`, `lastSimilarity`.

### `godcp_get_build_report`
Input: `{ project }` → the persisted `BuildReport` (or `REPORT_MISSING`).

---

## Unity

### `godcp_capture_render`
Input: `{ outputPath? }` → renders the active camera via Unity MCP (mock PNG when unconfigured) → `{ renderPath, unityProfile }`.

### `godcp_get_scene_hierarchy`
Input: `{}` → Unity scene hierarchy (verifies GODCP construction in-editor).

### `godcp_unity_status`
Input: `{}` → `{ profile, url, command, projectPath, available, tools[] }`.

---

## Semantic ops → Unity tools

GODCP never hardcodes Unity tool names. Semantic operations resolve per profile at runtime:

| Semantic op | mcpforunity | unity-official |
|---|---|---|
| `scene.create/open/save` | `manage_scene` | `Unity.ManageScene.*` |
| `object.*` | `manage_gameobject` | `Unity.ManageGameObject.*` |
| `asset.import/prefab/instantiate` | `manage_asset` / `manage_prefabs` | `Unity.ManageAsset.*` |
| `camera.configure` | `manage_camera` | `Unity.ManageCamera.*` |
| `render.screenshot` | camera capture | screenshot tool |

Arguments are then adapted against the tool's advertised JSON schema (unknown fields dropped, aliases mapped). Unmatched ops fall back to fuzzy name matching; override everything with `UNITY_MCP_TOOL_MAP=/path/to/map.json`.
