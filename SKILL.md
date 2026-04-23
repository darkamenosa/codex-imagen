---
name: codex-imagen
description: Generate or edit raster images by calling the ChatGPT/Codex Responses image_generation tool directly with local Codex or OpenClaw OAuth credentials, then save decoded image files for OpenClaw and other agent workflows.
metadata:
  openclaw:
    emoji: "🖼️"
    requires:
      bins: ["node"]
---

# Codex Imagen

Generate images by calling the ChatGPT/Codex backend directly with OAuth credentials already stored on the machine. This does not start `codex app-server`, does not need the Codex CLI binary, and does not require `OPENAI_API_KEY`.

## Quick Start

Run the helper through Node for macOS, Linux, and Windows compatibility:

```bash
node {baseDir}/scripts/codex-imagen.mjs 'generate image follow this prompt, no refine: "a cinematic fantasy city at sunrise"'
```

Normal generation prints one generated image path per line. Diagnostics and progress go to stderr.

Use `--json` when the caller needs machine-readable metadata:

```bash
node {baseDir}/scripts/codex-imagen.mjs --json --prompt 'generate a small blue lotus icon'
```

## Auth Discovery

The CLI reads existing OAuth JSON and sends `Authorization: Bearer <access>` plus `ChatGPT-Account-Id` to `https://chatgpt.com/backend-api/codex/responses`.

Run a local auth check without generating:

```bash
node {baseDir}/scripts/codex-imagen.mjs --smoke
```

Auth lookup order:

1. `--auth`
2. `CODEX_IMAGEN_AUTH_JSON`, `OPENCLAW_CODEX_AUTH_JSON`, `CODEX_AUTH_JSON`
3. `OPENCLAW_AGENT_DIR/auth-profiles.json` or `PI_CODING_AGENT_DIR/auth-profiles.json`
4. `~/.openclaw/agents/main/agent/auth-profiles.json`
5. `~/.openclaw/credentials/oauth.json`
6. `CODEX_HOME/auth.json`
7. `~/.codex/auth.json`

For OpenClaw, the current auth store is usually:

```text
~/.openclaw/agents/main/agent/auth-profiles.json
```

Codex CLI is not required at runtime. The skill works with OAuth created by OpenClaw itself, for example `openclaw onboard --auth-choice openai-codex` or `openclaw models auth login --provider openai-codex`. It only needs an existing `openai-codex` OAuth profile; it does not perform the first browser login itself.

`auth-state.json` beside it is used only to prefer OpenClaw's `lastGood.openai-codex` profile. Pass `--auth-profile openai-codex:<id>` when a specific OpenClaw profile should be used.

## Output Paths

Use `--out-dir` or `-o/--output` when the caller needs a specific artifact location:

```bash
node {baseDir}/scripts/codex-imagen.mjs --out-dir ./openclaw-images --prompt 'generate three UI icon variants'
node {baseDir}/scripts/codex-imagen.mjs -o out/ --prompt 'generate 3 images of a monk mage'
```

When `--out-dir` is not set, the script chooses the first available location:

1. `CODEX_IMAGEN_OUT_DIR`
2. `OPENCLAW_OUTPUT_DIR`
3. `OPENCLAW_AGENT_DIR/artifacts/codex-imagen`
4. `OPENCLAW_STATE_DIR/artifacts/codex-imagen`
5. `./codex-imagen-output`

If a run times out after partial results, already-received images remain saved and are printed.

## Reference Images

Attach reference images explicitly. Do not use positional image paths; positional arguments are reserved for prompt text.

```bash
node {baseDir}/scripts/codex-imagen.mjs --input-ref ref1.png --input-ref ref2.jpg --prompt 'generate 3 images of him livestreaming in this world'
node {baseDir}/scripts/codex-imagen.mjs -i ref1.png -i ref2.jpg --prompt 'change the main character into a woman'
```

Local images are converted to `data:image/...;base64,...` and sent as `input_image` items. `--input-ref` accepts local paths, `http(s)` URLs, and `data:image/...` URLs. Supported local formats are PNG, JPEG, GIF, and WebP. Use smaller JPEG references when high-fidelity pixel detail is not needed.

## OAuth Refresh

The CLI refreshes expired or near-expiry OAuth tokens through `https://auth.openai.com/oauth/token` and writes the updated token back to the same auth file. For OpenClaw `auth-profiles.json`, refresh uses OpenClaw-compatible cross-agent OAuth refresh locking, then locks the auth store before rereading and writing credentials. This avoids `refresh_token_reused` races when multiple OpenClaw or agent processes share one `openai-codex` profile.

Use these controls when needed:

```bash
node {baseDir}/scripts/codex-imagen.mjs --refresh-only --json
node {baseDir}/scripts/codex-imagen.mjs --force-refresh --smoke --json
node {baseDir}/scripts/codex-imagen.mjs --no-refresh --prompt 'generate one image'
```

For concurrent OpenClaw processes, prefer the active OpenClaw agent's `auth-profiles.json` so every caller uses the same profile identity. Use `--no-refresh` only when the caller already owns OAuth refresh and wants this helper to use the provided access token as-is.

## Cross-Platform Notes

The helper is plain Node.js 22+ with no native dependencies. It uses `os.homedir()` and environment overrides for Windows, Linux, and macOS. In `cmd.exe`, single quotes are not shell quotes; use double quotes or write UTF-8 text to a file and use:

```bash
node {baseDir}/scripts/codex-imagen.mjs --prompt-file prompt.txt
```

Use `--cwd <path>` when another agent launches this script from an unpredictable working directory.
