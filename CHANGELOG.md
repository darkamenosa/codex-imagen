# Changelog

All notable changes to `codex-imagen` are recorded here.

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
