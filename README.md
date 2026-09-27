# GODCP MCP

**Reference environment image → 3D assets (Meshy) → Unity scene → render → visual comparison → iterative correction.**

GODCP is a production-quality [Model Context Protocol](https://modelcontextprotocol.io) server written in TypeScript. You give it a picture of an environment (a street, a plaza, a forest clearing); it analyzes the image, plans a scene, generates 3D assets through [Meshy](https://www.meshy.ai), builds the scene in Unity through a Unity MCP endpoint, renders it, compares render vs. reference, and corrects itself — up to a similarity target.

```
reference.png
    │  vision (heuristic offline | OpenAI-compatible VLM)
    ▼
ReferenceAnalysis ──► ScenePlan ──► AssetManifest
                                          │  registry reuse → Meshy cache → Meshy generate
                                          ▼
                                   downloaded GLB/OBJ
                                          │
        Unity MCP ◄── scene construction (objects, materials, lights, camera)
                                          │
                                   render (screenshot)
                                          │
                          compare(render, reference) ──► corrections
                                          │                │
                                          └── loop ────────┘
    ▼
BuildReport (status, iterations, similarity, credits, warnings)
```

## Quick start

```bash
npm install
npm run typecheck        # tsc clean
npm test                 # 37 tests, fully offline
npm run demo             # end-to-end offline build (mock Unity, no API keys)
```

The demo generates a synthetic reference image, runs the entire pipeline, and prints a `BuildReport` like:

```json
{
  "status": "completed",
  "project": "demo",
  "iterations": 1,
  "finalSimilarity": 0.87,
  "assetsGenerated": 0,
  "meshyCreditsSpent": 0,
  "finalRenderPath": "assets/renders/demo/iteration-01.png"
}
```

### With real Meshy + Unity

```bash
cp .env.example .env      # then fill in MESHY_API_KEY, UNITY_MCP_URL, UNITY_PROJECT_PATH
npm run cli -- build path/to/reference.png --scene MyStreet --iterations 3
```

## MCP server

```bash
npm run dev               # tsx src/index.ts  (stdio transport — what MCP clients spawn)
npm start                 # node dist/index.js (after npm run build)
```

Register in **opencode** (`opencode.json`):

```jsonc
{
  "mcp": {
    "godcp": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "cwd": "C:/path/to/GODCP-mcp",
      "environment": { "MESHY_API_KEY": "{env:MESHY_API_KEY}" },
      "enabled": true
    }
  }
}
```

All tools are prefixed `godcp_*` — see [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md).

## CLI

```bash
npm run cli -- analyze <image>                 # vision analysis
npm run cli -- plan <image> -s MyScene         # analysis + scene plan (persisted)
npm run cli -- manifest <project>              # asset manifest from stored plan
npm run cli -- generate <project> --dry-run    # what would be generated?
npm run cli -- build <image> -s MyScene -i 3   # full pipeline
npm run cli -- status <project>                # state, iterations, similarity
npm run cli -- report <project>                # BuildReport
npm run cli -- assets --category building      # registry contents
npm run cli -- capture out.png                 # render current Unity view
npm run cli -- compare ref.png render.png      # one-off comparison
npm run cli -- doctor                          # config/key/connectivity check
npm run cli -- demo                            # offline end-to-end demo
```

## Guarantees & design

- **Cost control** — Meshy call budgets (`GODCP_MAX_MESHY_GENERATIONS`), request cache, similarity target, `--dry-run`, optional generation approval (`GODCP_REQUIRE_GENERATION_APPROVAL` + `GODCP_APPROVE_ALL=1`), and an asset **registry** so identical objects are never generated twice.
- **Resumable builds** — every stage (analyzed → planned → manifested → assets_ready → constructed → completed) persists to `state/projects/<slug>/`; re-running resumes, a completed build returns its stored report.
- **Structured errors** — everything throws `{ success:false, stage, errorCode, message, retryable, details }` (MCP tool results and CLI stderr are identical envelopes).
- **Graceful degradation** — no `MESHY_API_KEY`? Meshy assets fall back to primitives with warnings (build still completes). No Unity? `MockUnityProvider` renders synthetic PNGs whose lighting responds to the scene, so the compare/correct loop runs offline.
- **Unity-agnostic mapping** — semantic ops (`scene.create`, `object.primitive`, …) resolve to whatever your Unity MCP server advertises: profiles for `mcpforunity`, `unity-official`, fuzzy fallback, JSON override via `UNITY_MCP_TOOL_MAP`.

## Configuration

Everything is environment-driven (see [.env.example](.env.example)): Meshy key/base URL, Unity MCP URL/command/profile, vision provider (`heuristic` | `openai`), paths, transports (`stdio` | `http`), budgets, and the similarity target.

| Variable | Default | Purpose |
|---|---|---|
| `MESHY_API_KEY` | — | Meshy 3D generation (unset = primitive fallback) |
| `UNITY_MCP_URL` / `UNITY_MCP_COMMAND` | — / — | Unity MCP endpoint (unset = mock Unity) |
| `UNITY_MCP_PROFILE` | `generic` | `mcpforunity` \| `unity-official` \| `generic` \| `mock` |
| `VISION_PROVIDER` | `heuristic` | `heuristic` (offline) \| `openai` (VLM) |
| `GODCP_MAX_MESHY_GENERATIONS` | `20` | hard generation budget |
| `GODCP_MAX_ITERATIONS` | `3` | render/compare/correct loop cap |
| `GODCP_SIMILARITY_TARGET` | `0.85` | stop iterating at this similarity |
| `GODCP_DRY_RUN` | `false` | plan without spending credits |

## Documentation

- [docs/MCP-TOOLS.md](docs/MCP-TOOLS.md) — every MCP tool with inputs/outputs
- [docs/SETUP.md](docs/SETUP.md) — Unity MCP, Meshy, OpenCode/opencode wiring
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — pipeline stages, state machine, models
- [docs/API-RESEARCH.md](docs/API-RESEARCH.md) — Meshy/MCP/Unity API findings

## Development

```bash
npm run typecheck   # tsc (tests included)
npm run build       # dist/
npm test            # vitest (offline, mocked providers)
npm run test:watch
```

Layout: `src/server` (MCP wiring + tools), `src/orchestration` (pipelines + loop), `src/planner`, `src/meshy`, `src/unity`, `src/vision`, `src/registry`, `src/models`, `src/utils`, `src/cli` — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
