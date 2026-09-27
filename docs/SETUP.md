# Setup

## 1. Install

```bash
npm install
npm run typecheck && npm test   # both must be clean
npm run demo                    # offline proof: full pipeline with mock Unity
```

## 2. Meshy (3D generation)

1. Get a key: Meshy dashboard → **Settings → API Keys**.
2. `cp .env.example .env` and set `MESHY_API_KEY=sk-…`.
3. Verify: `npm run cli -- doctor` → `meshy.keyPresent: true`.

Without a key the pipeline still works: registry reuse + procedural/primitive assets, with warnings (never a hard failure for `build`). The `generate` command requires a key (or `--dry-run`).

Safety rails: `GODCP_MAX_MESHY_GENERATIONS` (default 20), `GODCP_DRY_RUN=true`, `GODCP_REQUIRE_GENERATION_APPROVAL=true` + `GODCP_APPROVE_ALL=1` (CLI `generate --approve`), request-level cache, and the asset registry (same object never generated twice).

## 3. Unity MCP

GODCP is an MCP **client** to Unity — any server exposing scene/gameobject/asset tools works.

**Option A — MCP for Unity (recommended)**
```env
UNITY_MCP_URL=http://localhost:8080/mcp
UNITY_MCP_PROFILE=mcpforunity
UNITY_PROJECT_PATH=C:/Projects/MyGame
```

**Option B — Unity official MCP relay (stdio)**
```env
UNITY_MCP_COMMAND=npx -y unity-mcp-relay
UNITY_MCP_PROFILE=unity-official
```

**Option C — nothing configured (default):** `MockUnityProvider` simulates the hierarchy and renders synthetic PNGs that respond to scene lighting/materials, so the compare/correct loop still runs end-to-end.

Tool-name differences are handled by profiles; if your Unity server uses unusual names, provide a JSON override:

```env
UNITY_MCP_TOOL_MAP=C:/path/to/tool-map.json
```
```json
{ "scene.create": [{ "tool": "MyTools.NewScene", "args": { "name": "$sceneName" } }] }
```

Verification: `npm run cli -- doctor` → `checks.unity.available`, or the `godcp_unity_status` tool.

Optional helper: `unity/GODCPUnity/Editor/GODCPScreenshotBridge.cs` — copy into `Assets/Editor/` if your Unity MCP server lacks a screenshot tool; it writes a camera PNG on demand.

## 4. Vision

| Provider | Config | Notes |
|---|---|---|
| `heuristic` (default) | none | offline pixel analysis, works on PNG; confidence ~0.4 |
| `openai` | `VISION_API_KEY`, `VISION_BASE_URL`, `VISION_MODEL` | any OpenAI-compatible chat-completions endpoint with image input |

## 5. Wire up an MCP client (opencode example)

`opencode.json`:
```jsonc
{
  "mcp": {
    "godcp": {
      "type": "local",
      "command": ["node", "dist/index.js"],   // or ["npx", "tsx", "src/index.ts"]
      "cwd": "C:/path/to/GODCP-mcp",
      "environment": { "MESHY_API_KEY": "{env:MESHY_API_KEY}" },
      "enabled": true,
      "timeout": 600000                        // builds are long-running
    }
  }
}
```

Then ask the agent: *"Use godcp_build_environment_from_reference on C:/refs/street.png, scene name Street01, 3 iterations."*

HTTP transport instead of stdio: `GODCP_TRANSPORT=http`, endpoint `POST http://127.0.0.1:3100/mcp`.

## 6. Typical session

```bash
npm run cli -- doctor
npm run cli -- build C:/refs/street.png -s Street01 --dry-run     # plan + budget preview
npm run cli -- build C:/refs/street.png -s Street01 -i 3          # real build
npm run cli -- report street01
```

Artifacts: `state/projects/<slug>/` (analysis, plan, manifest, state, iterations, report), `assets/generated/<slug>/` (models), `assets/renders/<slug>/` (iteration PNGs).
