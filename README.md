# Codex Imagen

[![CI](https://github.com/darkamenosa/codex-imagen/actions/workflows/ci.yml/badge.svg)](https://github.com/darkamenosa/codex-imagen/actions/workflows/ci.yml)

OpenClaw skill and helper CLI for generating images through the local Codex app-server.

This uses the machine's existing Codex/ChatGPT authentication and the built-in Codex `imagegen` skill. It does not require `OPENAI_API_KEY`.

## Requirements

- Node.js 18+
- A working local Codex installation with `codex app-server`
- Local Codex/ChatGPT auth on the machine

On macOS, the helper auto-detects Codex Desktop at:

```text
/Applications/Codex.app/Contents/Resources/codex
```

On Linux and Windows, install the Codex CLI or provide the binary path:

```bash
npm install -g @openai/codex
```

## Quick Start

From this repo:

```bash
node scripts/codex-imagen.mjs --smoke
```

Generate one image:

```bash
node scripts/codex-imagen.mjs 'can generate image follow this prompt, no refine? "a cinematic fantasy city at sunrise"'
```

Normal generation prints one generated image path per line:

```text
/tmp/codex-imagen-output/ig_....png
```

Generate multiple images by asking for them in the prompt:

```bash
node scripts/codex-imagen.mjs --timeout-ms 900000 'can generate 3 images follow this prompt, no refine? "three distinct ancient ARPG MMO screenshots"'
```

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

The summary includes:

- `imageCount`
- `images[].decodedPath`
- `images[].revisedPrompt`
- turn/thread IDs
- timeout state
- app-server metadata

## Debug Tracing

Normal runs only write image files. They do not write `codex-imagen.jsonl`.

Use `--debug` when you need a redacted app-server JSON-RPC trace:

```bash
node scripts/codex-imagen.mjs --debug 'generate a small icon'
```

Use `--log` for a specific trace path:

```bash
node scripts/codex-imagen.mjs --log /tmp/codex-imagen.jsonl 'generate a small icon'
```

## Binary Detection

Codex binary lookup order:

1. `--codex-bin`
2. `CODEX_IMAGEN_CODEX_BIN`
3. `CODEX_APP_SERVER_BIN`
4. `CODEX_BIN`
5. macOS Codex Desktop bundled binary
6. `codex` on `PATH`
7. npm global executable locations from `npm config get prefix`
8. common Linux/macOS/Windows executable directories
9. platform release binary names such as `codex-x86_64-unknown-linux-musl`

## Prompt Notes

The underlying image tool may return a `revisedPrompt`. That is normal.

To keep the prompt closer to the original wording, use:

```text
can generate image follow this prompt, no refine? "<exact prompt>"
```

For long prompts or Windows shell quoting, write the prompt to a UTF-8 file and use:

```bash
node scripts/codex-imagen.mjs --prompt-file prompt.txt
```

## Exit Codes

- `0`: success
- `1`: generation failed or no image returned
- `2`: invalid CLI usage
- `4`: timed out after saving at least one image
- `124`: timed out with no images

## Notes

This is an experimental wrapper around Codex app-server behavior. It depends on the local Codex installation exposing compatible app-server and image generation features.

## Development

Run local static checks:

```bash
npm run check
```

The CI workflow only checks syntax and CLI help/version output. It does not call live Codex image generation because that requires local app auth.

## License

MIT
