# Codex Imagen

[![CI](https://github.com/darkamenosa/codex-imagen/actions/workflows/ci.yml/badge.svg)](https://github.com/darkamenosa/codex-imagen/actions/workflows/ci.yml)

OpenClaw skill and helper CLI for generating or editing images through the ChatGPT/Codex Responses backend with local OAuth credentials.

This calls the native Responses `image_generation` tool at the Codex backend. It does not start `codex app-server`, does not require a Codex binary, does not use the public Images API, and does not require `OPENAI_API_KEY`.

## Requirements

- Node.js 22+
- Existing Codex or OpenClaw `openai-codex` OAuth credentials on the machine

Supported auth stores:

- OpenClaw auth profiles: `~/.openclaw/agents/main/agent/auth-profiles.json`
- OpenClaw agent auth: `~/.openclaw/agents/main/agent/auth.json`
- OpenClaw legacy OAuth: `~/.openclaw/credentials/oauth.json`
- Codex CLI/Desktop: `~/.codex/auth.json`

## Quick Start

Check auth without generating:

```bash
node scripts/codex-imagen.mjs --smoke
```

Generate one image:

```bash
node scripts/codex-imagen.mjs 'generate image follow this prompt, no refine: "a cinematic fantasy city at sunrise"'
```

Generate multiple images by asking for them in the prompt. There is no `--count` flag.

```bash
node scripts/codex-imagen.mjs --timeout-ms 900000 'generate 3 images follow this prompt, no refine: "three distinct ancient ARPG MMO screenshots"'
```

Normal generation prints one saved PNG path per line. Diagnostics and progress are written to stderr unless `--quiet` is used.

## CLI Usage

```bash
node scripts/codex-imagen.mjs "prompt" [options]
```

Prompt options:

- `--prompt <text>`: prompt text.
- `--prompt-file <path>`: read UTF-8 prompt text from a file.
- Positional text is accepted when `--prompt` and `--prompt-file` are not used.

Reference image options:

- `-i, --image <path>`: attach local image files. Repeat or comma-separate.
- `--input-ref <path|url>`: attach local paths, `http(s)` URLs, or `data:image/...` URLs. Repeat or comma-separate.
- `--image-url <url>`: attach an `http(s)` or `data:image/...` URL.
- `--image-detail <auto|low|high|original>`: set the Responses `input_image.detail` value. Default: `high`.

Output options:

- `-o, --output <path>`: exact PNG path for one image, directory for many, or a path template that is numbered for multiple images.
- `--out-dir <path>`: output directory when `--output` is not provided.
- `--json`: print a machine-readable summary instead of only image paths.

Runtime options:

- `--model <name>`: model slug. Default: `gpt-5.4`.
- `--timeout-ms <ms>`: abort after this many milliseconds. Default: `900000`; use `0` to disable.
- `--no-stream`: request a non-streaming response. By default streaming mode saves each image as soon as it arrives.
- `--quiet`: suppress progress diagnostics on stderr.
- `--verbose` or `--debug`: print request progress and raw event names to stderr.
- `--cwd <path>`: resolve relative input/output paths from this working directory.
- `--base-url <url>`: Codex backend base URL. Default: `https://chatgpt.com/backend-api/codex`.
- `--refresh-url <url>`: OAuth refresh endpoint. Default: `https://auth.openai.com/oauth/token`.

Auth options:

- `--auth <path>`: explicit auth JSON path.
- `--auth-profile <id>`: OpenClaw profile id, for example `openai-codex:hxtxmu@gmail.com`.
- `--smoke`: print redacted auth metadata and exit without generation.
- `--force-refresh`: refresh OAuth before generating.
- `--refresh-only`: refresh OAuth and exit. Does not require a prompt.
- `--no-refresh`: disable proactive refresh and the 401 refresh retry.

## Reference Images

Use explicit reference-image flags. Positional arguments are reserved for prompt text.

```bash
node scripts/codex-imagen.mjs --input-ref ref1.png --input-ref ref2.jpg --prompt 'generate 3 images of him livestreaming in this world'
node scripts/codex-imagen.mjs -i ref1.png -i ref2.jpg --prompt 'change the main character into a woman'
node scripts/codex-imagen.mjs --image-url 'https://example.com/ref.png' --prompt 'use this image as the environment reference'
```

Local references are converted to base64 `data:image/...` input images before sending. Supported local formats are PNG, JPEG, GIF, and WebP. The CLI warns when a base64 reference is large; use smaller JPEG references when high-fidelity pixel detail is not needed.

## Output Paths

When no output option is set, the first available directory is used:

1. `CODEX_IMAGEN_OUT_DIR`
2. `OPENCLAW_OUTPUT_DIR`
3. `OPENCLAW_AGENT_DIR/artifacts/codex-imagen`
4. `OPENCLAW_STATE_DIR/artifacts/codex-imagen`
5. `./codex-imagen-output`

Automatic filenames use:

```text
codex-imagen-<timestamp>-<optional-index>-<image-call-id>.png
```

`--output` behavior:

- `--output image.png` with one image writes exactly `image.png`.
- `--output image.png` with multiple images writes `image-1.png`, `image-2.png`, and so on.
- `--output out/` or `--output out` treats the value as a directory and uses automatic filenames.
- `--out-dir out` always writes automatic filenames under `out`.

In streaming mode, each image is written as soon as it arrives. If a run times out after partial results, already saved images remain on disk and are still printed.

## Auth Lookup

Lookup order:

1. `--auth`
2. `CODEX_IMAGEN_AUTH_JSON`, `OPENCLAW_CODEX_AUTH_JSON`, `CODEX_AUTH_JSON`
3. `OPENCLAW_AGENT_DIR/auth-profiles.json` or `PI_CODING_AGENT_DIR/auth-profiles.json`
4. `OPENCLAW_AGENT_DIR/auth.json` or `PI_CODING_AGENT_DIR/auth.json`
5. `~/.openclaw/agents/main/agent/auth-profiles.json`
6. `~/.openclaw/agents/main/agent/auth.json`
7. `~/.openclaw/credentials/oauth.json`
8. `CODEX_HOME/auth.json`
9. `~/.codex/auth.json`

Profile selection for OpenClaw `auth-profiles.json`:

1. `--auth-profile`
2. `CODEX_IMAGEN_AUTH_PROFILE` or `OPENCLAW_AUTH_PROFILE`
3. sibling `auth-state.json` `lastGood.openai-codex`
4. best available `openai-codex` OAuth profile, preferring `openai-codex:default`, later expiry, email, and account id

Codex CLI is optional. If OpenClaw created the `openai-codex` OAuth profile through `openclaw onboard --auth-choice openai-codex` or `openclaw models auth login --provider openai-codex`, this helper can use that profile directly without installing Codex CLI. The helper reads and refreshes existing credentials; it does not run the first browser login itself.

## OAuth Refresh

The CLI refreshes expired or near-expiry OAuth tokens with the OpenAI OAuth refresh endpoint and writes updates back to the same auth file. The default refresh skew is 60 seconds.

When the auth file is OpenClaw's `auth-profiles.json`, refresh uses the same cross-agent lock path OpenClaw uses for `openai-codex` OAuth profiles, then locks the auth store before rereading and writing credentials. That prevents concurrent agents from racing on one single-use refresh token and causing `refresh_token_reused`.

```bash
node scripts/codex-imagen.mjs --refresh-only --json
node scripts/codex-imagen.mjs --force-refresh --smoke --json
node scripts/codex-imagen.mjs --no-refresh --prompt 'generate one image'
```

Use `--no-refresh` only when the caller already owns token refresh. For normal standalone/OpenClaw skill usage, leave refresh enabled.

## JSON Output

Use `--json` for the full machine-readable summary:

```bash
node scripts/codex-imagen.mjs --json 'generate a small blue lotus icon'
```

Generation JSON includes:

- `request_id`, `session_id`, `endpoint`, `model`
- `image_count` and `imageCount`
- `images[].path` and `images[].decodedPath`
- `images[].bytes`, `sha256`, `call_id`, `status`, `partial`, `revised_prompt`
- `seen_event_types`
- `timed_out`
- `auth_refresh` when refresh happened or was skipped during the run

`--smoke --json` prints redacted auth metadata. `--refresh-only --json` prints refresh metadata.

## OpenClaw Usage

Use the skill directory as an OpenClaw skill:

```text
codex-imagen/
  SKILL.md
  scripts/codex-imagen.mjs
```

OpenClaw callers should usually rely on the active agent auth store and output directory:

```bash
node {baseDir}/scripts/codex-imagen.mjs --json --prompt 'generate an image'
```

Use `--cwd <path>` when another agent launches this script from an unpredictable working directory.

## Cross-Platform Notes

The helper is plain Node.js 22+ and uses `os.homedir()`, `path`, and environment overrides instead of platform-specific shell behavior. It should work on macOS, Linux, and Windows.

In Windows `cmd.exe`, single quotes are not shell quotes, so use double quotes or `--prompt-file`:

```bat
node scripts\codex-imagen.mjs --prompt-file prompt.txt --out-dir out
```

PowerShell accepts normal quoted strings, but for long prompts `--prompt-file` is still safer.

## Exit Codes

- `0`: success, including a timeout after at least one streaming image was saved
- `1`: generation failed, no image returned, HTTP error, or timeout before any image was saved
- `2`: invalid CLI usage

## Development

Run local static checks:

```bash
npm run check
```

The CI workflow checks syntax and CLI help/version output. It does not call live image generation because that requires local OAuth credentials.

## License

MIT
