# Examples

## 1. Offline demo (no keys, no Unity)

```bash
npm run demo
```

Generates `assets/references/example-reference.png` (synthetic street scene), runs the whole pipeline against `MockUnityProvider`, and prints a `BuildReport`. All state lands in `state/projects/demo/`.

## 2. Real build

```bash
cp .env.example .env    # set MESHY_API_KEY, UNITY_MCP_URL, UNITY_PROJECT_PATH
npm run cli -- build assets/references/example-reference.png -s DemoStreet -i 3
npm run cli -- report demoStreet
```

## 3. Step-by-step (what the MCP tools do)

```bash
npm run cli -- analyze assets/references/example-reference.png --json
npm run cli -- plan assets/references/example-reference.png -s DemoStreet
npm run cli -- manifest demoStreet
npm run cli -- generate demoStreet --dry-run     # budget preview
npm run cli -- generate demoStreet --approve     # real Meshy generation
npm run cli -- capture assets/renders/manual.png
npm run cli -- compare assets/references/example-reference.png assets/renders/manual.png
```

## 4. As MCP tools (in a client like opencode)

- `godcp_build_environment_from_reference` — one-shot build
- `godcp_create_scene_plan` → `godcp_create_asset_manifest` → `godcp_generate_assets` — staged control
- `godcp_capture_render` → `godcp_compare_images` — inspect a single iteration
- `godcp_get_build_status` / `godcp_get_build_report` — audit cost & similarity
- `godcp_list_assets` / `godcp_registry_stats` — reuse inventory
- `godcp_unity_status` / `godcp_get_scene_hierarchy` — Unity connectivity

## 5. opencode config snippet

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
