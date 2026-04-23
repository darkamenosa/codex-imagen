# Changelog

All notable changes to `codex-imagen` are recorded here.

## Unreleased

## [0.2.5] - 2026-04-23

### Fixed

- Match OpenClaw's `refresh_token_reused` detection more closely by recognizing reused-refresh-token message text even when the OAuth response omits the structured error code.

## [0.2.4] - 2026-04-23

### Fixed

- Recover from `refresh_token_reused` before asking the user to sign in again: continue with a still-valid access token for proactive refresh failures, or retry once when another process rotated the stored refresh token but left the selected profile stale.

## [0.2.3] - 2026-04-23

### Changed

- Added seconds-based `--timeout` and `--timeout-seconds` flags for OpenClaw-aligned agent usage, while keeping `--timeout-ms` for compatibility and fine-grained tests.
- Added Codex-style transient generation retries: `--retries 4` by default for 5 total attempts, plus `--no-retry`, covering HTTP 5xx, transport failures, backend server failures, and dropped/incomplete streams before any image is saved.
- Prevented unbounded generation runs by rejecting non-positive timeout values; generation timeouts must now be positive.
- Added an OpenClaw-aware 5 minute default timeout and a hard watchdog that exits with code `124` if aborting the generation request does not settle.
- Improved OpenClaw auth-profile auto-selection so profiles without `accountId` are not selected by default.
- Surfaced backend `error` and `response.failed` details when generation returns no completed image.
- Updated skill docs to recommend `--timeout 300` for 5 minute OpenClaw calls because OpenClaw `exec.timeout` is also seconds.
- Expanded README and skill instructions to document the current CLI flags, auth lookup behavior, reference image modes, output naming, streaming, timeout, JSON, and diagnostics behavior.
- Updated skill UI metadata to describe image editing and multi-output paths.

## [0.2.2] - 2026-04-23

### Added

- Added the project changelog and included it in the tagged GitHub release.

## [0.2.1] - 2026-04-23

### Added

- Added OAuth refresh for Codex and OpenClaw auth files, including OpenClaw-compatible cross-agent locking for shared `openai-codex` profiles.
- Ignored generated `out/` image artifacts in git.

### Changed

- Simplified the CLI implementation while preserving prompt, reference-image, multi-output, and JSON behavior.
- Kept Node.js 22+ as the documented target without enforcing it at runtime.

## [0.2.0] - 2026-04-23

### Changed

- Switched the helper from the Codex app-server flow to direct ChatGPT/Codex Responses `image_generation` calls using local OAuth credentials.
- Updated the skill, README, package metadata, and OpenAI skill metadata for direct OAuth usage.

### Added

- Added OpenClaw auth-profile discovery, Codex auth fallback discovery, reference image inputs, smoke checks, JSON output, verbose diagnostics, timeout handling, and multi-image streaming saves.

## [0.1.3] - 2026-04-22

### Added

- Added public repository metadata and README documentation.
