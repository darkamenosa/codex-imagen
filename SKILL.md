---
name: codex-imagen
description: Generate raster images through the local Codex app-server using the machine's Codex/ChatGPT auth, then save decoded image files for OpenClaw workflows.
metadata:
  openclaw:
    emoji: "🖼️"
    requires:
      bins: ["node"]
    install:
      - id: codex-cli
        kind: npm
        package: "@openai/codex"
        bins: ["codex"]
        label: "Install Codex CLI (npm)"
---

# Codex Imagen

Generate images by starting `codex app-server`, sending a `$imagegen` turn, and decoding every returned image into local files. This uses the local Codex installation and ChatGPT/Codex auth on the machine; it does not require `OPENAI_API_KEY`.

## Quick Start

Run the helper through Node for macOS, Linux, and Windows compatibility:

```bash
node {baseDir}/scripts/codex-imagen.mjs 'can generate image follow this prompt, no refine? "a cinematic fantasy city at sunrise"'
```

Normal generation prints one generated image path per line. This matches OpenClaw's artifact-oriented helper scripts, where stdout is the file handoff and diagnostics go to stderr.

Use `--json` when you need the full machine-readable summary, including `images[].decodedPath`, `images[].revisedPrompt`, timing state, and app-server metadata.

## Runtime Checks

Before generating, verify that the local Codex app-server and `imagegen` skill can be seen:

```bash
node {baseDir}/scripts/codex-imagen.mjs --smoke
```

The script auto-detects the Codex binary in this order:

1. `--codex-bin`
2. `CODEX_IMAGEN_CODEX_BIN`
3. `CODEX_APP_SERVER_BIN`
4. `CODEX_BIN`
5. macOS Codex.app bundled binary at `/Applications/Codex.app/Contents/Resources/codex`
6. `codex` on `PATH`
7. npm global executable locations from `npm config get prefix`
8. common platform locations:
   - Linux/macOS: Node's own bin directory, `~/.local/bin`, `~/.npm-global/bin`, `~/bin`, Homebrew paths, `/usr/local/bin`, `/usr/bin`, `/bin`, `/snap/bin`
   - Windows: `%APPDATA%\npm`, `%LOCALAPPDATA%\Microsoft\WindowsApps`, `%ProgramFiles%\nodejs`, `%ProgramFiles(x86)%\nodejs`
9. Codex release archive names for the current platform, such as `codex-x86_64-unknown-linux-musl`

Set one of these when auto-detection is not enough:

```bash
CODEX_IMAGEN_CODEX_BIN=/path/to/codex
CODEX_APP_SERVER_BIN=/path/to/codex
CODEX_BIN=/path/to/codex
```

You can also pass `--codex-bin /path/to/codex`.

## Output Paths

Use `--out-dir` when the caller needs a specific artifact directory:

```bash
node {baseDir}/scripts/codex-imagen.mjs --out-dir /tmp/openclaw-images --prompt "generate two UI icon variants"
```

When `--out-dir` is not set, the script chooses the first available location:

1. `CODEX_IMAGEN_OUT_DIR`
2. `OPENCLAW_OUTPUT_DIR`
3. `OPENCLAW_AGENT_DIR/artifacts/codex-imagen`
4. `OPENCLAW_STATE_DIR/artifacts/codex-imagen`
5. `./codex-imagen-output`

Normal runs write image files only. They do not write `codex-imagen.jsonl`.

Use `--debug` only when you need the redacted app-server JSON-RPC trace:

```bash
node {baseDir}/scripts/codex-imagen.mjs --debug "generate a small icon"
```

`--debug` writes `<out-dir>/codex-imagen.jsonl` and progress diagnostics to stderr. Use `--log /path/to/file.jsonl` or `CODEX_IMAGEN_LOG` when you need a specific trace path.

## Multiple Images

Ask for the count in the prompt. The CLI does not need an `--expect-images` flag; it saves every `imageGeneration` item that arrives before the turn completes or times out.

```bash
node {baseDir}/scripts/codex-imagen.mjs --timeout-ms 900000 --prompt 'can generate 3 images follow this prompt, no refine? "three distinct ancient ARPG MMO screenshots"'
```

If the turn times out after partial results, the command still prints the images it saved. Exit code `4` means timed out with at least one image; exit code `124` means timed out with no images.

## Prompt Notes

The underlying image tool may return a `revisedPrompt`; that is normal behavior. To keep the prompt closer to the original wording, ask directly:

```text
can generate image follow this prompt, no refine? "<exact prompt>"
```

For long prompts or Windows shell quoting, write the prompt to a UTF-8 file and use `--prompt-file`.
