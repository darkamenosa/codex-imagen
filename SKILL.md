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

Generate or edit images by calling the ChatGPT/Codex backend directly with OAuth credentials already stored on the machine. This calls the native Responses `image_generation` tool, does not start `codex app-server`, does not need the Codex CLI binary, and does not require `OPENAI_API_KEY`.

## Quick Start

Run the helper through Node for macOS, Linux, and Windows compatibility:

```bash
node {baseDir}/scripts/codex-imagen.mjs --timeout 300 'generate image follow this prompt, no refine: "a cinematic fantasy city at sunrise"'
```

Normal generation prints one generated image path per line. Diagnostics and progress go to stderr.

Use `--json` when the caller needs machine-readable metadata:

```bash
node {baseDir}/scripts/codex-imagen.mjs --json --timeout 300 --prompt 'generate a small blue lotus icon'
```

Ask for multiple outputs in the prompt. There is no `--count` flag:

```bash
node {baseDir}/scripts/codex-imagen.mjs --timeout 300 -o out/ --prompt 'generate 3 images of a monk mage'
```

Use `--verbose` or `--debug` for event-level progress, and `--quiet` when only stdout paths/JSON should be emitted.

## Retry Behavior

The helper retries transient empty failures by default: network errors, HTTP 5xx responses, backend `server_error` / overloaded / unavailable responses, and dropped/incomplete streams that end before a completed image arrives. Default is `--retries 4`, meaning 5 total attempts, matching Codex's request retry shape.

Retries are intentionally not used for usage errors, auth errors, policy/input errors, rate limits, generation timeouts, or after an image has already been saved. If streaming saves partial images and then times out, the helper returns those saved paths instead of starting a duplicate generation. The `--timeout` value applies per generation attempt, so an outer OpenClaw `exec.timeout` must budget for retries when retries are enabled.

Use `--no-retry` or `--retries 0` when an outer caller owns retry behavior.

## Timeout Units

Use `--timeout <seconds>` for agent-facing calls. This intentionally matches OpenClaw's surrounding `exec` tool `timeout` value, which is also in seconds. For a 5 minute OpenClaw call, use `--timeout 300`.

`--timeout-ms <milliseconds>` remains available for compatibility and sub-second tests. Do not use `--timeout-ms 300` when you mean 5 minutes; that is only 0.3 seconds. Use either `--timeout`, `--timeout-seconds`, or `--timeout-ms`, not more than one in the same command.

## Generation Timing

Image generation can be slow, especially when the prompt asks for multiple images. For chat-facing OpenZalo/OpenClaw calls:

- Use `--timeout 300` for ordinary one-image requests.
- For prompts that ask for 3 images, prefer `--timeout 600`, or ask for 2 images when the conversation should return quickly.
- If a 3-image request reaches the timeout after saving 1 or 2 images, the helper returns those saved paths with `timed_out: true`; this is a usable partial success, not a hang.
- The `--timeout` value applies per generation attempt. If default retries are enabled, set the outer OpenClaw `exec.timeout` higher than the helper timeout budget, or reduce retries with `--retries 1` / `--no-retry`.

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
4. `OPENCLAW_AGENT_DIR/auth.json` or `PI_CODING_AGENT_DIR/auth.json`
5. `~/.openclaw/agents/main/agent/auth-profiles.json`
6. `~/.openclaw/agents/main/agent/auth.json`
7. `~/.openclaw/credentials/oauth.json`
8. `CODEX_HOME/auth.json`
9. `~/.codex/auth.json`

For OpenClaw, the current auth store is usually:

```text
~/.openclaw/agents/main/agent/auth-profiles.json
```

Codex CLI is not required at runtime. The skill works with OAuth created by OpenClaw itself, for example `openclaw onboard --auth-choice openai-codex` or `openclaw models auth login --provider openai-codex`. It only needs an existing `openai-codex` OAuth profile; it does not perform the first browser login itself.

`auth-state.json` beside it is used only to prefer OpenClaw's `lastGood.openai-codex` profile. Pass `--auth-profile openai-codex:<id>` when a specific OpenClaw profile should be used. The same value can come from `CODEX_IMAGEN_AUTH_PROFILE` or `OPENCLAW_AUTH_PROFILE`.

## Output Paths

Use `--out-dir` or `-o/--output` when the caller needs a specific artifact location:

```bash
node {baseDir}/scripts/codex-imagen.mjs --out-dir ./openclaw-images --prompt 'generate three UI icon variants'
node {baseDir}/scripts/codex-imagen.mjs -o out/ --prompt 'generate 3 images of a monk mage'
```

`--output image.png` writes exactly that path for one image. If multiple images arrive, outputs are numbered as `image-1.png`, `image-2.png`, and so on. If `--output` has no extension or ends in `/`, it is treated as a directory. Without `--output`, automatic names use `codex-imagen-<timestamp>-<optional-index>-<image-call-id>.png`.

When `--out-dir` is not set, the script chooses the first available location:

1. `CODEX_IMAGEN_OUT_DIR`
2. `OPENCLAW_OUTPUT_DIR`
3. `OPENCLAW_AGENT_DIR/artifacts/codex-imagen`
4. `OPENCLAW_STATE_DIR/artifacts/codex-imagen`
5. `./codex-imagen-output`

Streaming is enabled by default and saves each image as soon as it arrives. If a run times out after partial results, already received images remain saved and are printed. Use `--timeout 300` for chat-facing OpenClaw calls unless the user explicitly asks for a longer run, or `--no-stream` to request a non-streaming response.

## Reference Images

Attach reference images explicitly. Do not use positional image paths; positional arguments are reserved for prompt text.

```bash
node {baseDir}/scripts/codex-imagen.mjs --input-ref ref1.png --input-ref ref2.jpg --prompt 'generate 3 images of him livestreaming in this world'
node {baseDir}/scripts/codex-imagen.mjs -i ref1.png -i ref2.jpg --prompt 'change the main character into a woman'
node {baseDir}/scripts/codex-imagen.mjs --image-url 'https://example.com/ref.png' --prompt 'use this image as the world reference'
```

Local images are converted to `data:image/...;base64,...` and sent as `input_image` items. `--input-ref` accepts local paths, `http(s)` URLs, and `data:image/...` URLs. `-i/--image` is local-only, and `--image-url` is URL/data-URL only. Supported local formats are PNG, JPEG, GIF, and WebP. Use `--image-detail auto|low|high|original` when the model should receive lower or higher image detail; default is `high`. Use smaller JPEG references when high-fidelity pixel detail is not needed.

## OAuth Refresh

The CLI refreshes expired or near-expiry OAuth tokens through `https://auth.openai.com/oauth/token` and writes the updated token back to the same auth file. For OpenClaw `auth-profiles.json`, refresh uses OpenClaw-compatible cross-agent OAuth refresh locking, then locks the auth store before rereading and writing credentials. This avoids `refresh_token_reused` races when multiple OpenClaw or agent processes share one `openai-codex` profile.

Use these controls when needed:

```bash
node {baseDir}/scripts/codex-imagen.mjs --refresh-only --json
node {baseDir}/scripts/codex-imagen.mjs --force-refresh --smoke --json
node {baseDir}/scripts/codex-imagen.mjs --no-refresh --prompt 'generate one image'
```

For concurrent OpenClaw processes, prefer the active OpenClaw agent's `auth-profiles.json` so every caller uses the same profile identity. Use `--no-refresh` only when the caller already owns OAuth refresh and wants this helper to use the provided access token as-is.

Use `--base-url` only for a compatible Codex backend, and `--refresh-url` only for a compatible OAuth refresh endpoint.

## Cross-Platform Notes

The helper is plain Node.js 22+ with no native dependencies. It uses `os.homedir()` and environment overrides for Windows, Linux, and macOS. In `cmd.exe`, single quotes are not shell quotes; use double quotes or write UTF-8 text to a file and use:

```bash
node {baseDir}/scripts/codex-imagen.mjs --prompt-file prompt.txt
```

Use `--cwd <path>` when another agent launches this script from an unpredictable working directory.
