# Codex Imagen

[![CI](https://github.com/darkamenosa/codex-imagen/actions/workflows/ci.yml/badge.svg)](https://github.com/darkamenosa/codex-imagen/actions/workflows/ci.yml)

OpenClaw skill and helper CLI for generating images through the ChatGPT/Codex Responses backend with local OAuth credentials.

It does not start `codex app-server`, does not require a Codex binary, and does not require `OPENAI_API_KEY`.

## Requirements

- Node.js 22+
- Existing Codex or OpenClaw OAuth credentials on the machine

Supported auth files:

- Codex CLI/Desktop: `~/.codex/auth.json`
- OpenClaw auth profiles: `~/.openclaw/agents/main/agent/auth-profiles.json`
- OpenClaw legacy OAuth: `~/.openclaw/credentials/oauth.json`

## Quick Start

From this repo:

```bash
node scripts/codex-imagen.mjs --smoke
```

Generate one image:

```bash
node scripts/codex-imagen.mjs 'generate image follow this prompt, no refine: "a cinematic fantasy city at sunrise"'
```

Normal generation prints one generated image path per line:

```text
./codex-imagen-output/codex-imagen-....png
```

Generate multiple images by asking for them in the prompt:

```bash
node scripts/codex-imagen.mjs --timeout-ms 900000 'generate 3 images follow this prompt, no refine: "three distinct ancient ARPG MMO screenshots"'
```

## Reference Images

Use explicit reference-image flags. Positional arguments are reserved for prompt text.

```bash
node scripts/codex-imagen.mjs --input-ref ref1.png --input-ref ref2.jpg --prompt 'generate 3 images of him livestreaming in this world'
node scripts/codex-imagen.mjs -i ref1.png -i ref2.jpg --prompt 'change the main character into a woman'
```

Local references are converted to base64 `data:image/...` input images. `--input-ref` accepts local paths, `http(s)` URLs, and `data:image/...` URLs. PNG, JPEG, GIF, and WebP are supported.

## Auth Lookup

Lookup order:

1. `--auth`
2. `CODEX_IMAGEN_AUTH_JSON`, `OPENCLAW_CODEX_AUTH_JSON`, `CODEX_AUTH_JSON`
3. `OPENCLAW_AGENT_DIR/auth-profiles.json` or `PI_CODING_AGENT_DIR/auth-profiles.json`
4. `~/.openclaw/agents/main/agent/auth-profiles.json`
5. `~/.openclaw/credentials/oauth.json`
6. `CODEX_HOME/auth.json`
7. `~/.codex/auth.json`

Use `--auth-profile openai-codex:<id>` to select a specific OpenClaw profile.

Codex CLI is optional. If OpenClaw created the `openai-codex` OAuth profile through `openclaw onboard --auth-choice openai-codex` or `openclaw models auth login --provider openai-codex`, this helper can use that profile directly without installing Codex CLI. The helper reads and refreshes existing credentials; it does not run the first browser login itself.

## OpenClaw Usage

Use the skill directory as an OpenClaw skill:

```text
codex-imagen/
  SKILL.md
  scripts/codex-imagen.mjs
```

The script chooses the first available output directory:

1. `--out-dir`
2. `CODEX_IMAGEN_OUT_DIR`
3. `OPENCLAW_OUTPUT_DIR`
4. `OPENCLAW_AGENT_DIR/artifacts/codex-imagen`
5. `OPENCLAW_STATE_DIR/artifacts/codex-imagen`
6. `./codex-imagen-output`

## JSON Output

Use `--json` for the full machine-readable summary:

```bash
node scripts/codex-imagen.mjs --json 'generate a small blue lotus icon'
```

The summary includes `image_count`, `images[].path`, `images[].decodedPath`, `images[].revised_prompt`, request IDs, event types, timeout state, and auth-refresh metadata when a refresh happened.

## OAuth Refresh

The CLI refreshes expired or near-expiry OAuth tokens with the OpenAI OAuth refresh endpoint and writes updates back to the same auth file.

When the auth file is OpenClaw's `auth-profiles.json`, refresh uses the same cross-agent lock path OpenClaw uses for `openai-codex` OAuth profiles, then locks the auth store before rereading and writing credentials. That prevents concurrent agents from racing on one single-use refresh token and causing `refresh_token_reused`.

```bash
node scripts/codex-imagen.mjs --refresh-only --json
node scripts/codex-imagen.mjs --force-refresh --smoke --json
node scripts/codex-imagen.mjs --no-refresh --prompt 'generate one image'
```

Use `--no-refresh` only when the caller already owns token refresh. For normal standalone/OpenClaw skill usage, leave refresh enabled.

## Cross-Platform Notes

The helper is plain Node.js 22+ and uses `os.homedir()`, `path`, and environment overrides instead of platform-specific shell behavior. It should work on macOS, Linux, and Windows.

In Windows `cmd.exe`, single quotes are not shell quotes, so use double quotes or `--prompt-file`:

```bat
node scripts\codex-imagen.mjs --prompt-file prompt.txt --out-dir out
```

Use `--cwd` when another agent launches it from an unpredictable directory.

## Exit Codes

- `0`: success
- `1`: generation failed or no image returned
- `2`: invalid CLI usage
- `4`: timed out after saving at least one image
- `124`: timed out with no images

## Development

Run local static checks:

```bash
npm run check
```

The CI workflow checks syntax and CLI help/version output. It does not call live image generation because that requires local OAuth credentials.

## License

MIT
