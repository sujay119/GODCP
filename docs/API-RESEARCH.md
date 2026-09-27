# GODCP MCP — API & Protocol Research

Research date: 2026-09-27. All endpoints/schemas below were verified against live
documentation and machine-readable specs at implementation time. Nothing here is invented.

Primary sources:

| Topic | Source |
|---|---|
| Meshy API (authoritative) | `https://docs.meshy.ai/openapi.yaml` (108 KB OpenAPI spec), `https://docs.meshy.ai/api/*.md`, `https://docs.meshy.ai/llms.txt` |
| MCP specification | `https://modelcontextprotocol.io/specification/2025-06-18` (+ 2025-11-25 transports) |
| MCP TypeScript SDK | npm `@modelcontextprotocol/sdk@1.30.1`, `https://github.com/modelcontextprotocol/typescript-sdk` |
| Unity MCP (community) | `https://github.com/CoplayDev/unity-mcp` (v10.0.0), tool catalog `https://coplaydev.github.io/unity-mcp/reference/tools` |
| Unity MCP (official) | `https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.11/manual/integration/unity-mcp-overview.html` |
| OpenCode MCP config | `https://opencode.ai/docs/mcp-servers/` |

---

## 1. Meshy API

- **Base URL**: `https://api.meshy.ai/openapi/` (configurable via `MESHY_API_BASE_URL`)
- **Authentication**: `Authorization: Bearer <MESHY_API_KEY>` header on every request.
- **Content type**: `application/json` request/response bodies.
- **Task model**: all generation endpoints are asynchronous. `POST` returns `202 Accepted`
  with `{ "result": "<task-id>" }` immediately; you poll `GET .../{id}` until a terminal
  status. `GET .../{id}/stream` provides SSE progress updates (GODCP polls by default;
  SSE is available but polling is simpler and proxy-friendly).
- **Rate limiting / errors**: `400` invalid params, `401` bad key, `402` insufficient
  credits, `403` plan does not include endpoint, `404` not found, `409` conflict (delete
  while `IN_PROGRESS`), `422` unprocessable, `429` rate limit. Error body:
  `{ "message": string }`.

### 1.1 Endpoints used by GODCP

| Method | Path | Purpose |
|---|---|---|
| POST | `/v2/text-to-3d` | Create Text-to-3D task (`mode: "preview"`, `mode: "refine"`, or fused single-call) |
| GET | `/v2/text-to-3d/{id}` | Retrieve Text-to-3D task status/result |
| GET | `/v2/text-to-3d` | List Text-to-3D tasks (pagination: `page_num`, `page_size`, `sort_by`) |
| POST | `/v1/image-to-3d` | Create Image-to-3D task |
| GET | `/v1/image-to-3d/{id}` | Retrieve Image-to-3D task status/result |
| GET | `/v1/image-to-3d` | List Image-to-3D tasks |
| DELETE | `/v1/image-to-3d/{id}` | Delete a task (credits refunded only while `PENDING`) |
| GET | `/v1/balance` | (documented in spec; used by `godcp doctor` if available) |

Not used but available for future providers: multi-image-to-3d, retexture, remesh,
convert, resize, uv-unwrap, rigging, animations, text-to-image, image-to-image,
print/* endpoints.

### 1.2 Text to 3D — request schema (`POST /v2/text-to-3d`)

Key fields of `TextTo3DRequest` (from OpenAPI spec):

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `preview` \| `refine` | — | Required for the two-step flow. **Omit + `should_texture: true` for a fused single-call task** (requires account entitlement; otherwise ignored) |
| `prompt` | string ≤ 800 | — | Required for preview/fused |
| `preview_task_id` | string | — | Required when `mode: "refine"`; preview must be `SUCCEEDED` |
| `ai_model` | `meshy-4` \| `meshy-6` \| `meshy-6-lite` \| `meshy-7` \| `meshy-7.1` \| `latest` \| `meshy-t2` | `latest` | `latest` resolves to `meshy-7.1`. `meshy-7` deprecated. `meshy-t2` requires `model_type: smart-topology`. Some models require account entitlement |
| `model_type` | `standard` \| `lowpoly` \| `smart-topology` | `standard` | `lowpoly` deprecated → use `smart-topology` |
| `geometry_resolution` | `standard` \| `2k` \| `4k` | `standard` | Ultra pass; requires `meshy-7.1`/`latest`; +5 credits |
| `should_remesh` | boolean | model-dependent | Only meaningful with `topology`/`target_polycount`/`decimation_mode` |
| `topology` | `quad` \| `triangle` | `triangle` | `quad` unsupported for `meshy-t2` |
| `target_polycount` | 100–300000 | 30000 | Remesh or smart-topology target |
| `should_texture` | boolean | — | Fused one-call textured path |
| `enable_pbr` | boolean | `false` | PBR maps (metallic/roughness/normal/±emission) |
| `texture_prompt` / `texture_image_url` | string | — | Texturing guidance (max 800 chars; jpg/jpeg/png) |
| `pose_mode` | `a-pose` \| `t-pose` \| `""` | `""` | Characters |
| `target_formats` | `glb, obj, fbx, stl, usdz, 3mf` | all except `3mf` | Restricting formats speeds tasks up |
| `auto_size` / `origin_at` | boolean / `bottom`\|`center` | `false` / `bottom` | AI-estimated real-world size |
| `seed`, `count` (2–4), `moderation`, `name` | | | |

Response `202`: `{ "result": "<task-id>" }` (v2 POST also additively includes the full task object).

### 1.3 Image to 3D — request schema (`POST /v1/image-to-3d`)

Key fields of `ImageTo3DRequest`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `image_url` | string | — | **Exactly one of** `image_url` **or** `input_task_id`. http(s) URL or `data:image/...;base64,...` data URI (jpg/jpeg/png) |
| `input_task_id` | string | — | Reuse image from a succeeded text-to-image/image-to-image task; takes priority |
| `ai_model` | enum incl. `latest`, `meshy-7.1`, `meshy-t2` | `latest` | `meshy-t2` requires `model_type: smart-topology` |
| `model_type` | `standard` \| `lowpoly` \| `smart-topology` | `standard` | |
| `should_texture` | boolean | `true` | Without texture: cheaper |
| `enable_pbr` | boolean | `false` | |
| `texture_resolution` | `2k` \| `4k` \| `8k` | `2k` | 8k → no emission map |
| `should_remesh`, `topology`, `target_polycount`, `decimation_mode` | | | |
| `pose_mode`, `image_enhancement`, `remove_lighting` | | | |
| `texture_prompt`, `texture_image_url` | | | Max 800 chars / image |
| `target_formats` | format array | all except `3mf` | |
| `auto_size`, `origin_at`, `moderation`, `multi_view_thumbnails`, `name` | | | |

### 1.4 Task object (response of `GET .../{id}`)

`Task` / `TextTo3DTask` schemas (required: `id`, `status`, `created_at`, `progress`):

```jsonc
{
  "id": "018a210d-...",
  "type": "text-to-3d-preview | text-to-3d-refine | ...",
  "status": "PENDING | IN_PROGRESS | SUCCEEDED | FAILED | CANCELED",
  "progress": 0,                    // 0..100
  "created_at": 1692771650657,      // epoch ms
  "started_at": 0, "finished_at": 0,
  "preceding_tasks": 0,             // queue position while pending
  "model_urls": {                   // only produced formats present
    "glb": "https://assets.meshy.ai/.../model.glb?Expires=...",
    "fbx": "...", "obj": "...", "mtl": "...", "usdz": "...", "stl": "...",
    "3mf": "...", "pre_remeshed_glb": "..."
  },
  "texture_urls": [
    { "base_color": "...", "metallic": "...", "roughness": "...",
      "normal": "...", "emission": "...", "metallic_roughness": "..." }
  ],
  "thumbnail_url": "https://assets.meshy.ai/.../preview.png?Expires=...",
  "alpha_thumbnail_url": "...",      // only when alpha_thumbnail: true
  "thumbnail_urls": { "front": "...", "right": "...", ... }, // image-to-3d multi_view_thumbnails
  "task_error": { "type": "", "code": "", "message": "", "doc_url": "" }, // on failure
  "consumed_credits": 20             // 0 for FAILED tasks (refunded)
}
```

Notes verified:

- Download URLs are **signed and time-limited** (`Expires=...`); download promptly after
  success. `expires_at` (epoch ms) marks the asset download deadline.
- `texture_urls` entries only carry the maps that were generated (`enable_pbr: false`
  ⇒ often only `base_color`).
- Failed tasks: `consumed_credits` is `0` (credits refunded) and `task_error` is populated.
- Task status values: `PENDING`, `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `CANCELED`.

### 1.5 Task polling behavior (as implemented)

1. POST → get task id (or use returned task object).
2. Poll `GET` with interval starting at 1.5 s, exponential backoff ×1.35 up to 8 s,
   jittered; optional `onProgress(progress)` callback.
3. Stop on terminal status or when `timeoutMs` elapses → `MESHY_TASK_TIMEOUT` error.
4. HTTP-level failures during polling: retry with backoff on 429/5xx/network errors;
   401/402/403 fail fast (never retried).
5. `FAILED`/`CANCELED` → structured error carrying `task_error.message` (`MESHY_TASK_FAILED`,
   `retryable: false` unless the message indicates a transient condition).
6. Text-to-3D default flow = two-step: preview (`mode: "preview"`) → on `SUCCEEDED`, refine
   (`mode: "refine", preview_task_id`) when texturing is requested. Config supports
   `fused` (single call, `should_texture: true`) and `preview_only`.

### 1.6 Downloadable asset formats

`glb`, `fbx`, `gltf`, `obj` (+`mtl`), `usdz`, `stl`, `3mf`, plus `pre_remeshed_glb`.
GODCP downloads **GLB by preference** (best Unity import path), falling back to
`fbx` → `obj`, together with all available texture maps and the thumbnail.

### 1.7 Pricing/credits (as documented at research time)

Credit costs vary by model/options (e.g. text preview ~20, image-to-3d 5 without texture /
15 with texture for legacy models; ultra +5; 8k textures +15; retexture 10). GODCP
therefore treats every generation as a **budgeted operation** (`maxMeshyGenerations`,
`dryRun`, approval mode, registry reuse, cache) and records `consumed_credits` per task.

---

## 2. MCP specification & TypeScript SDK

- Protocol: JSON-RPC 2.0 over a pluggable transport. Latest stable spec revision used by
  the SDK: `2025-06-18` (transports updated in `2025-11-25`: Streamable HTTP is the
  recommended HTTP transport; legacy HTTP+SSE is deprecated).
- Primitives: **Tools** (model-invoked functions), **Resources**, **Prompts**;
  capability negotiation, server/client info handshake.
- SDK `@modelcontextprotocol/sdk@1.30.1` (accepts `zod ^3.25 || ^4.0`):
  - Server: `McpServer.registerTool(name, { title, description, inputSchema (Zod), outputSchema }, handler)`
    → derives JSON Schema, validates args before the handler runs; handler returns
    `{ content: [...], structuredContent?, isError? }`.
  - Transports: `StdioServerTransport` (for local child-process servers — the mode
    OpenCode spawns), `StreamableHTTPServerTransport` (optional HTTP mode).
  - Client: `Client` + `StreamableHTTPClientTransport` / `StdioClientTransport` —
    **used by GODCP to talk to a Unity MCP server as an MCP client**.
- GODCP MCP server: name `GODCP`, stdio transport by default, tools are
  high-level semantic operations (see `docs/MCP-TOOLS.md`).

## 3. Unity integration

There is **no single canonical Unity MCP**; three mainstream implementations exist.
GODCP therefore does not hard-code Unity tool names — it connects as an MCP client
and resolves semantic operations through **mapping profiles + live tool discovery**
(see `src/unity/toolMapping.ts`).

### 3.1 Implementation A — "MCP for Unity" (CoplayDev/unity-mcp, v10, MIT)

- Topology: `MCP client → [MCP over stdio or Streamable HTTP] → Python server
  (uvx mcp-for-unity) → [WebSocket] → Unity Editor plugin (UPM package)`.
- HTTP mode: `uvx --from mcpforunityserver mcp-for-unity --transport http
  --http-url http://localhost:8080` → MCP endpoint `http://localhost:8080/mcp`
  (env overrides: `UNITY_MCP_TRANSPORT`, `UNITY_MCP_HTTP_PORT`, ...).
- Tool catalog (47 entrypoints, verified): `manage_scene`, `manage_gameobject`,
  `manage_asset`, `manage_editor`, `manage_camera`, `manage_material`,
  `manage_prefabs`, `manage_texture`, `manage_components`, `find_gameobjects`,
  `read_console`, `execute_menu_item`, `batch_execute`, `refresh_unity`, `run_tests`,
  `set_active_instance`, ... Tools take an `action` discriminator plus action args and
  return JSON text content.
- This is GODCP's **default profile** (`mcpforunity`).

### 3.2 Implementation B — Unity official AI Assistant MCP (Unity 6 + `com.unity.ai.assistant`)

- Topology: `AI client → [MCP stdio] → relay binary (~/.unity/relay/, Windows:
  %USERPROFILE%\.unity\relay\relay_win.exe --mcp) → [named pipe / Unix socket IPC] →
  Unity MCP bridge inside the Editor`.
- Tool naming verified from package API docs: `[McpTool("Unity.ManageScene", ...)]`,
  `Unity.ManageGameObject`, `Unity.ImportExternalModel`, ... i.e. dotted `Unity.*` names
  with an `Action` argument convention (`Load/Save/Create/GetHierarchy`, etc.).
- First connection requires approval in `Edit > Project Settings > AI > Unity MCP`.
- Supported via profile `unity-official` + `UNITY_MCP_TRANSPORT=stdio` and
  `UNITY_MCP_COMMAND` pointing at the relay binary.

### 3.3 Implementation C — in-editor HTTP/SSE bridges (e.g. uMCP, AnkleBreaker)

- Pure in-editor MCP servers exposing Streamable HTTP directly
  (e.g. `http://localhost:7225/mcp`), or HTTP REST bridges (e.g. port 7890).
- Supported generically: any Streamable-HTTP MCP endpoint works with profile
  `generic` (tool names resolved by fuzzy capability matching at runtime).

### 3.4 What GODCP needs from Unity (semantic operations)

create/open/save scene · inspect hierarchy · create GameObject · import asset (model
file → `Assets/...`) · create prefab · instantiate · set position/rotation/scale ·
assign material/color/texture · create light · configure camera · create primitives ·
duplicate · group/parent · delete · **capture screenshot/render to file** · inspect
object state. Each maps to a profile entry with an argument builder; unavailability
produces a structured `UNITY_TOOL_UNAVAILABLE` error (never a fake success).

### 3.5 Screenshot rendering

Rendering is the one capability not uniformly exposed. Resolution order:
1. `godcp_render_screenshot` — custom MCP tool registered by the bundled optional
   `unity/GODCPUnity` Editor package (highest fidelity, writes PNG to absolute path).
2. Profile-specific screenshot/capture tools when present (e.g. camera capture tools).
3. Otherwise: structured error `UNITY_RENDER_UNAVAILABLE` (build pipeline stops before
   comparison instead of pretending).

---

## 4. OpenCode MCP configuration (verified from current docs)

OpenCode config lives in `opencode.json` / `opencode.jsonc` (workspace) or
`~/.config/opencode/opencode.json` (global) with `$schema: https://opencode.ai/config.json`.
Servers are declared under `mcp` with a unique name; tool names are prefixed with the
server name (e.g. `godcp_build_environment_from_reference`).

Local server (how GODCP is connected — OpenCode spawns the process over stdio):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "godcp": {
      "type": "local",
      "command": ["node", "/absolute/path/GODCP-mcp/dist/index.js"],
      "cwd": "/absolute/path/GODCP-mcp",
      "environment": {
        "MESHY_API_KEY": "{env:MESHY_API_KEY}",
        "UNITY_MCP_URL": "http://localhost:8080/mcp",
        "GODCP_UNITY_PROJECT": "/path/MyUnityProject"
      },
      "enabled": true,
      "timeout": 10000
    }
  }
}
```

Options verified: `type` (`local`|`remote`), `command` (array), `cwd`, `environment`,
`enabled`, `timeout` (ms, default 5000); remote servers use `url` + `headers` (+ OAuth
handling). Per-agent enablement via `agent.<name>.tools`, global disable via `tools`.

---

## 5. Known limitations (honest list)

1. **Image analysis is not exact.** Heuristic vision (default, offline) yields coarse
   structure + low confidence (0.3–0.55). The `openai` vision provider (OpenAI-compatible
   chat completions with image input) raises fidelity substantially. Uncertainty is always
   represented explicitly in `ReferenceAnalysis.confidence` and per-object confidence.
2. **Vision comparison cannot measure exact geometry** without a 3D-aware model;
   corrections are best-effort semantic deltas (scale/placement/color/lighting/composition)
   with per-item confidence.
3. **Meshy URLs are signed & expire**; cached downloads are stored locally so re-runs do
   not re-download. Task deletion refunds credits only while `PENDING`.
4. **Fused text-to-3d (`should_texture` single call) requires account entitlement**;
   GODCP defaults to the documented two-step preview→refine flow.
5. **Unity MCP variance**: tool names/args differ across implementations; the mapping
   profiles cover MCP for Unity (default) and Unity official, plus a `generic` fuzzy
   resolver. Unknown/unavailable capabilities fail loudly.
6. **Screenshot capability depends on the Unity MCP implementation** (§3.5).
7. **PNG-only pixel heuristics** (pure-JS decoder, no native deps): JPEG references get
   metadata-level analysis unless a vision LLM provider is configured.
8. **Real Meshy/Unity integration requires credentials/live connections**; the test suite
   runs fully mocked (`MESHY_API_KEY` never required for tests).
9. Meshy `3mf` is opt-in only; `meshy-7` is deprecated in favor of `meshy-7.1`;
   `meshy-5` is retired (migrate to `meshy-6-lite`).
