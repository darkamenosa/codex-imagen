#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_REFRESH_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_OPENCLAW_AGENT_ID = "main";
const DEFAULT_CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const PACKAGE_VERSION = "0.2.5";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_REFRESH_SKEW_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_OPENCLAW_TIMEOUT_MS = 5 * 60 * 1000;
const FORCE_EXIT_AFTER_ABORT_MS = 10_000;
const DEFAULT_RETRIES = 4;
const MAX_RETRIES = 100;
const RETRY_BASE_DELAY_MS = 200;
const DEFAULT_IMAGE_DETAIL = "high";
const LARGE_DATA_URL_WARNING_BYTES = 15 * 1024 * 1024;
const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
const AUTH_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
};
const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 180_000,
};
const OAUTH_REFRESH_CALL_TIMEOUT_MS = 120_000;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

class GenerationFailedError extends Error {
  constructor(message, { backendErrors = [], seenEventTypes = [] } = {}) {
    super(message);
    this.name = "GenerationFailedError";
    this.backendErrors = backendErrors;
    this.seenEventTypes = seenEventTypes;
  }
}

function usage() {
  return `Usage:
  codex-imagen "prompt" [options]
  node scripts/codex-imagen.mjs "prompt" [options]

Options:
  --prompt <text>       Prompt text. Positional text is also accepted.
  --prompt-file <path>  Read prompt from a UTF-8 file.
  -i, --image <path>    Attach local reference image(s). Repeat or comma-separate.
  --input-ref <path|url>
                        Attach a reference image from a local path, http(s) URL, or data:image URL.
                        Repeat or comma-separate.
  --image-url <url>     Attach an image URL or data:image/... URL as a reference.
  --image-detail <mode> input_image detail: high, low, auto, original. Default: ${DEFAULT_IMAGE_DETAIL}
  -o, --output <path>   Output PNG path.
                        If multiple images arrive, saves name-1.png, name-2.png, ...
                        If this has no extension or ends in /, treats it as a directory.
  --out-dir <path>      Output directory when --output is not provided.
  --model <name>        Model slug. Default: ${DEFAULT_MODEL}
  --auth <path>         Auth JSON path. Supports Codex auth.json, OpenClaw auth-profiles.json,
                        OpenClaw agent/legacy auth.json, and OpenClaw credentials/oauth.json.
  --auth-profile <id>   OpenClaw auth profile id. Default: auth-state lastGood, then best openai-codex OAuth profile.
  --base-url <url>      Codex backend base URL. Default: ${DEFAULT_BASE_URL}
  --refresh-url <url>   OAuth refresh endpoint. Default: ${DEFAULT_REFRESH_URL}
  --cwd <path>          Resolve relative input/output paths from this working directory.
  --smoke               Check auth discovery and print redacted auth metadata. No generation.
  --force-refresh       Refresh Codex OAuth before generating.
  --refresh-only        Refresh Codex OAuth and exit. Does not require a prompt.
  --no-refresh          Disable proactive refresh and 401 refresh retry.
  --retries <count>     Retry transient empty failures this many times. Default: ${DEFAULT_RETRIES}.
  --no-retry            Disable transient generation retries.
  --timeout <seconds>   Abort after this many seconds. Default: ${DEFAULT_TIMEOUT_MS / 1000};
                        ${DEFAULT_OPENCLAW_TIMEOUT_MS / 1000} when OpenClaw runtime is detected.
  --timeout-seconds <s> Alias for --timeout.
  --timeout-ms <ms>     Advanced: abort after this many milliseconds. Must be greater than 0.
  --no-stream           Request a non-streaming response.
  --json                Print a JSON summary instead of only the image path.
  --quiet               Do not print progress diagnostics to stderr.
  --verbose             Print request progress and raw event names to stderr.
  --debug               Alias for --verbose.
  --version             Print version.
  -h, --help            Show this help.

Auth discovery order:
  1. --auth
  2. CODEX_IMAGEN_AUTH_JSON, OPENCLAW_CODEX_AUTH_JSON, CODEX_AUTH_JSON
  3. OPENCLAW_AGENT_DIR/auth-profiles.json or PI_CODING_AGENT_DIR/auth-profiles.json
  4. OPENCLAW_AGENT_DIR/auth.json or PI_CODING_AGENT_DIR/auth.json
  5. ~/.openclaw/agents/main/agent/auth-profiles.json
  6. ~/.openclaw/agents/main/agent/auth.json
  7. ~/.openclaw/credentials/oauth.json
  8. CODEX_HOME/auth.json
  9. ~/.codex/auth.json
`;
}

function parseArgs(argv) {
  const options = {
    authPath: null,
    authProfile: process.env.CODEX_IMAGEN_AUTH_PROFILE || process.env.OPENCLAW_AUTH_PROFILE || null,
    baseUrl: DEFAULT_BASE_URL,
    cwd: null,
    forceRefresh: false,
    imageDetail: DEFAULT_IMAGE_DETAIL,
    imagePaths: [],
    imageUrls: [],
    json: false,
    model: DEFAULT_MODEL,
    outDir: null,
    output: null,
    prompt: null,
    promptFile: null,
    quiet: false,
    refresh: true,
    refreshOnly: false,
    refreshSkewSeconds: DEFAULT_REFRESH_SKEW_SECONDS,
    refreshUrl: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || DEFAULT_REFRESH_URL,
    retries: DEFAULT_RETRIES,
    smoke: false,
    stream: true,
    timeoutMs: null,
    timeoutMsExplicit: false,
    timeoutFlag: null,
    verbose: false,
  };

  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new UsageError(`Missing value for ${arg}`);
      }
      return argv[i];
    };
    const longValue = (name) => {
      const prefix = `${name}=`;
      return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
    };

    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--version") {
      options.version = true;
    } else if (longValue("--prompt") !== null) {
      options.prompt = longValue("--prompt");
    } else if (arg === "--prompt") {
      options.prompt = next();
    } else if (longValue("--prompt-file") !== null) {
      options.promptFile = longValue("--prompt-file");
    } else if (arg === "--prompt-file") {
      options.promptFile = next();
    } else if (longValue("--image") !== null) {
      options.imagePaths.push(...splitCommaValues(longValue("--image")));
    } else if (arg === "-i" || arg === "--image") {
      options.imagePaths.push(...splitCommaValues(next()));
    } else if (longValue("--input-ref") !== null) {
      addInputRefs(options, longValue("--input-ref"));
    } else if (arg === "--input-ref") {
      addInputRefs(options, next());
    } else if (longValue("--image-url") !== null) {
      options.imageUrls.push(longValue("--image-url"));
    } else if (arg === "--image-url") {
      options.imageUrls.push(next());
    } else if (longValue("--image-detail") !== null) {
      const value = longValue("--image-detail");
      if (!["auto", "low", "high", "original"].includes(value)) {
        throw new UsageError("--image-detail must be one of: auto, low, high, original");
      }
      options.imageDetail = value;
    } else if (arg === "--image-detail") {
      const value = next();
      if (!["auto", "low", "high", "original"].includes(value)) {
        throw new UsageError("--image-detail must be one of: auto, low, high, original");
      }
      options.imageDetail = value;
    } else if (longValue("--output") !== null) {
      options.output = longValue("--output");
    } else if (arg === "-o" || arg === "--output") {
      options.output = next();
    } else if (longValue("--out-dir") !== null) {
      options.outDir = longValue("--out-dir");
    } else if (arg === "--out-dir") {
      options.outDir = next();
    } else if (longValue("--model") !== null) {
      options.model = longValue("--model");
    } else if (arg === "--model") {
      options.model = next();
    } else if (longValue("--auth") !== null) {
      options.authPath = longValue("--auth");
    } else if (arg === "--auth") {
      options.authPath = next();
    } else if (longValue("--auth-profile") !== null) {
      options.authProfile = longValue("--auth-profile");
    } else if (arg === "--auth-profile") {
      options.authProfile = next();
    } else if (longValue("--base-url") !== null) {
      options.baseUrl = longValue("--base-url");
    } else if (arg === "--base-url") {
      options.baseUrl = next();
    } else if (longValue("--refresh-url") !== null) {
      options.refreshUrl = longValue("--refresh-url");
    } else if (arg === "--refresh-url") {
      options.refreshUrl = next();
    } else if (longValue("--cwd") !== null) {
      options.cwd = longValue("--cwd");
    } else if (arg === "--cwd") {
      options.cwd = next();
    } else if (arg === "--smoke") {
      options.smoke = true;
    } else if (arg === "--force-refresh") {
      options.forceRefresh = true;
    } else if (arg === "--refresh-only") {
      options.refreshOnly = true;
    } else if (arg === "--no-refresh") {
      options.refresh = false;
    } else if (longValue("--retries") !== null) {
      options.retries = parseRetries(longValue("--retries"));
    } else if (arg === "--retries") {
      options.retries = parseRetries(next());
    } else if (arg === "--no-retry") {
      options.retries = 0;
    } else if (longValue("--timeout") !== null) {
      setTimeoutOption(options, longValue("--timeout"), "seconds", "--timeout");
    } else if (arg === "--timeout") {
      setTimeoutOption(options, next(), "seconds", "--timeout");
    } else if (longValue("--timeout-seconds") !== null) {
      setTimeoutOption(options, longValue("--timeout-seconds"), "seconds", "--timeout-seconds");
    } else if (arg === "--timeout-seconds") {
      setTimeoutOption(options, next(), "seconds", "--timeout-seconds");
    } else if (longValue("--timeout-ms") !== null) {
      setTimeoutOption(options, longValue("--timeout-ms"), "milliseconds", "--timeout-ms");
    } else if (arg === "--timeout-ms") {
      setTimeoutOption(options, next(), "milliseconds", "--timeout-ms");
    } else if (arg === "--no-stream") {
      options.stream = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--debug") {
      options.verbose = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if ((options.prompt || options.promptFile) && positionals.length > 0) {
    throw new UsageError(
      `Unexpected positional argument with --prompt: ${positionals[0]}. Use -i/--image or --input-ref for reference images.`
    );
  } else if (!options.prompt && positionals.length > 0) {
    options.prompt = positionals.join(" ");
  }

  return options;
}

function setTimeoutOption(options, value, unit, flag) {
  if (options.timeoutMsExplicit) {
    throw new UsageError(
      `Use only one timeout option. ${options.timeoutFlag} was already provided; remove ${flag}.`
    );
  }

  options.timeoutMs =
    unit === "seconds" ? parseTimeoutSeconds(value, flag) : parseTimeoutMs(value, flag);
  options.timeoutMsExplicit = true;
  options.timeoutFlag = flag;
}

function parseRetries(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RETRIES) {
    throw new UsageError(`--retries must be an integer from 0 to ${MAX_RETRIES}`);
  }
  return parsed;
}

function parseTimeoutSeconds(value, flag = "--timeout") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be greater than 0 seconds so generation cannot run unbounded`);
  }
  return Math.ceil(parsed * 1000);
}

function parseTimeoutMs(value, flag = "--timeout-ms") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be greater than 0 milliseconds so generation cannot run unbounded`);
  }
  return Math.ceil(parsed);
}

function timeoutSeconds(timeoutMs) {
  return Number((timeoutMs / 1000).toFixed(3));
}

function describeTimeout(timeoutMs) {
  return `${timeoutSeconds(timeoutMs)}s (${timeoutMs}ms)`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(retryNumber) {
  const exp = 2 ** Math.max(0, retryNumber - 1);
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.max(0, Math.round(RETRY_BASE_DELAY_MS * exp * jitter));
}

function formatDelay(ms) {
  return `${Number((ms / 1000).toFixed(3))}s`;
}

function pathLooksInsideOpenClaw(pathname) {
  const normalized = path.resolve(pathname).split(path.sep);
  return normalized.includes(".openclaw") || normalized.includes(".clawdbot");
}

function isOpenClawRuntime() {
  return Boolean(
    process.env.OPENCLAW_AGENT_DIR?.trim() ||
      process.env.PI_CODING_AGENT_DIR?.trim() ||
      process.env.OPENCLAW_STATE_DIR?.trim() ||
      process.env.OPENCLAW_OUTPUT_DIR?.trim() ||
      pathLooksInsideOpenClaw(process.cwd())
  );
}

function defaultTimeoutMs() {
  return isOpenClawRuntime() ? DEFAULT_OPENCLAW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function resolveUserPath(input) {
  if (!input) {
    return input;
  }

  if (input === "~") {
    return os.homedir();
  }

  const slash = input.startsWith("~/") || input.startsWith("~\\");
  if (slash) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function existingFileSync(pathname) {
  try {
    return !!pathname && fsSync.statSync(pathname).isFile();
  } catch {
    return false;
  }
}

function existingDirSync(pathname) {
  try {
    return !!pathname && fsSync.statSync(pathname).isDirectory();
  } catch {
    return false;
  }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolvePathFromCwd(input) {
  return path.resolve(resolveUserPath(input));
}

function resolveOpenClawStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolvePathFromCwd(override);
  }

  const current = path.join(os.homedir(), ".openclaw");
  if (existingDirSync(current)) {
    return current;
  }

  const legacy = path.join(os.homedir(), ".clawdbot");
  if (existingDirSync(legacy)) {
    return legacy;
  }

  return current;
}

function resolveOpenClawAgentDir() {
  const override = process.env.OPENCLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    return resolvePathFromCwd(override);
  }
  return path.join(resolveOpenClawStateDir(), "agents", DEFAULT_OPENCLAW_AGENT_ID, "agent");
}

function resolveOpenClawOAuthDir() {
  const override = process.env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) {
    return resolvePathFromCwd(override);
  }
  return path.join(resolveOpenClawStateDir(), "credentials");
}

function resolveOpenClawOAuthRefreshLockPath(provider, profileId) {
  const hash = createHash("sha256");
  hash.update(provider, "utf8");
  hash.update("\u0000", "utf8");
  hash.update(profileId, "utf8");
  return path.join(resolveOpenClawStateDir(), "locks", "oauth-refresh", `sha256-${hash.digest("hex")}`);
}

function authPathCandidates() {
  const envCandidates = [
    process.env.CODEX_IMAGEN_AUTH_JSON,
    process.env.OPENCLAW_CODEX_AUTH_JSON,
    process.env.CODEX_AUTH_JSON,
  ].map((value) => (value?.trim() ? resolvePathFromCwd(value.trim()) : null));

  const codexHome = process.env.CODEX_HOME?.trim()
    ? path.join(resolvePathFromCwd(process.env.CODEX_HOME.trim()), "auth.json")
    : null;

  return uniq([
    ...envCandidates,
    path.join(resolveOpenClawAgentDir(), "auth-profiles.json"),
    path.join(resolveOpenClawAgentDir(), "auth.json"),
    path.join(resolveOpenClawOAuthDir(), "oauth.json"),
    codexHome,
    DEFAULT_CODEX_AUTH_PATH,
  ]);
}

function resolveAuthPath(options) {
  if (options.authPath) {
    return resolvePathFromCwd(options.authPath);
  }

  const candidates = authPathCandidates();
  const found = candidates.find(existingFileSync);
  if (found) {
    return found;
  }

  throw new Error(
    `No auth JSON found. Tried:\n${candidates.map((candidate) => `  - ${candidate}`).join("\n")}`
  );
}

function defaultOutputDir() {
  const explicit =
    process.env.CODEX_IMAGEN_OUT_DIR?.trim() || process.env.OPENCLAW_OUTPUT_DIR?.trim();
  if (explicit) {
    return resolvePathFromCwd(explicit);
  }

  const agentDir = process.env.OPENCLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    return path.join(resolvePathFromCwd(agentDir), "artifacts", "codex-imagen");
  }

  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(resolvePathFromCwd(stateDir), "artifacts", "codex-imagen");
  }

  return path.resolve(process.cwd(), "codex-imagen-output");
}

function normalizeOptions(options) {
  if (options.cwd) {
    process.chdir(resolvePathFromCwd(options.cwd));
  }

  if (!options.timeoutMsExplicit) {
    options.timeoutMs = defaultTimeoutMs();
  }

  options.outDir = options.outDir ? resolvePathFromCwd(options.outDir) : defaultOutputDir();
  options.authPath = resolveAuthPath(options);
  return options;
}

function splitCommaValues(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function addInputRefs(options, value) {
  for (const ref of splitCommaValues(value)) {
    if (/^data:image\//i.test(ref) || /^https?:\/\//i.test(ref)) {
      options.imageUrls.push(ref);
    } else {
      options.imagePaths.push(ref);
    }
  }
}

function logVerbose(options, message) {
  if (options.verbose) {
    console.error(message);
  }
}

function logProgress(options, message) {
  if (!options.quiet) {
    console.error(message);
  }
}

const HELD_LOCKS = new Map();

function releaseAllLocksSync() {
  for (const [normalizedFile, held] of HELD_LOCKS) {
    void held.handle.close().catch(() => undefined);
    try {
      fsSync.rmSync(held.lockPath, { force: true });
    } catch {
      // Best-effort process-exit cleanup.
    }
    HELD_LOCKS.delete(normalizedFile);
  }
}

process.once("exit", releaseAllLocksSync);

function computeDelayMs(retries, attempt) {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt)
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}

async function readLockPayload(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function resolveNormalizedFilePath(filePath) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  try {
    const realDir = await fs.realpath(dir);
    return path.join(realDir, path.basename(resolved));
  } catch {
    return resolved;
  }
}

async function isStaleLock(lockPath, staleMs) {
  const payload = await readLockPayload(lockPath);
  if (payload?.pid && !isPidAlive(payload.pid)) {
    return true;
  }
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) {
      return true;
    }
  }
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

async function releaseHeldLock(normalizedFile) {
  const current = HELD_LOCKS.get(normalizedFile);
  if (!current) {
    return;
  }
  current.count -= 1;
  if (current.count > 0) {
    return;
  }
  HELD_LOCKS.delete(normalizedFile);
  await current.handle.close().catch(() => undefined);
  await fs.rm(current.lockPath, { force: true }).catch(() => undefined);
}

function createFileLockTimeoutError(normalizedFile, lockPath) {
  return Object.assign(new Error(`file lock timeout for ${normalizedFile}`), {
    code: FILE_LOCK_TIMEOUT_ERROR_CODE,
    lockPath,
  });
}

async function acquireFileLock(filePath, options) {
  const normalizedFile = await resolveNormalizedFilePath(filePath);
  const lockPath = `${normalizedFile}.lock`;
  const held = HELD_LOCKS.get(normalizedFile);
  if (held) {
    held.count += 1;
    return {
      lockPath,
      release: () => releaseHeldLock(normalizedFile),
    };
  }

  for (let attempt = 0; attempt <= options.retries.retries; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
        "utf8"
      );
      HELD_LOCKS.set(normalizedFile, { count: 1, handle, lockPath });
      return {
        lockPath,
        release: () => releaseHeldLock(normalizedFile),
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await isStaleLock(lockPath, options.stale)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (attempt >= options.retries.retries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
    }
  }

  throw createFileLockTimeoutError(normalizedFile, lockPath);
}

async function withFileLock(filePath, options, fn) {
  const lock = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

function base64UrlDecode(input) {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

async function readAuthWithOptions(authPath, options) {
  const raw = await fs.readFile(authPath, "utf8");
  const auth = JSON.parse(raw);
  return parseAuthJson(auth, authPath, options);
}

function normalizeExpiresMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value > 10_000_000_000 ? value : value * 1000;
}

function profileAccess(profile) {
  return profile.access ?? profile.access_token ?? profile.token ?? null;
}

function profileRefresh(profile) {
  return profile.refresh ?? profile.refresh_token ?? null;
}

function profileAccountId(profile) {
  return profile.accountId ?? profile.account_id ?? profile.account ?? null;
}

function readSiblingAuthState(authPath) {
  const statePath = path.join(path.dirname(authPath), "auth-state.json");
  if (!existingFileSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(fsSync.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function scoreOpenClawProfile(profileId, profile, state) {
  let score = 0;
  const lastGood = state?.lastGood?.["openai-codex"];
  if (lastGood && profileId === lastGood) {
    score += 1_000_000;
  }
  if (profileId === "openai-codex:default") {
    score += 1000;
  }
  const expiresMs = normalizeExpiresMs(profile.expires);
  if (expiresMs) {
    score += Math.min(999_999, Math.max(0, Math.floor((expiresMs - Date.now()) / 1000)));
  }
  if (profile.email) {
    score += 100;
  }
  if (profileAccountId(profile)) {
    score += 100;
  }
  return score;
}

function isOpenClawCodexOAuthProfile(profile) {
  return profile?.type === "oauth" && profile.provider === "openai-codex";
}

function isUsableOpenClawCodexOAuthProfile(profile) {
  return isOpenClawCodexOAuthProfile(profile) && Boolean(profileAccess(profile)) && Boolean(profileAccountId(profile));
}

function selectOpenClawProfile(store, authPath, options = {}) {
  const profiles = store.profiles ?? {};
  const requested = options.authProfile?.trim();
  if (requested) {
    const profile = profiles[requested];
    if (!profile) {
      throw new Error(`OpenClaw auth profile not found in ${authPath}: ${requested}`);
    }
    return { profileId: requested, profile };
  }

  const state = readSiblingAuthState(authPath);
  const lastGood = state?.lastGood?.["openai-codex"];
  if (lastGood && isUsableOpenClawCodexOAuthProfile(profiles[lastGood])) {
    return { profileId: lastGood, profile: profiles[lastGood] };
  }

  const candidates = Object.entries(profiles).filter(
    ([, profile]) => isOpenClawCodexOAuthProfile(profile) && profileAccess(profile)
  );
  const usableCandidates = candidates.filter(([, profile]) => profileAccountId(profile));
  const rankedCandidates = usableCandidates.length > 0 ? usableCandidates : candidates;
  rankedCandidates.sort(
    ([leftId, leftProfile], [rightId, rightProfile]) =>
      scoreOpenClawProfile(rightId, rightProfile, state) -
      scoreOpenClawProfile(leftId, leftProfile, state)
  );

  if (candidates.length === 0) {
    throw new Error(`No openai-codex OAuth profile found in ${authPath}`);
  }

  const [profileId, profile] = rankedCandidates[0];
  return { profileId, profile };
}

function selectProviderMapProfile(record, authPath, options = {}) {
  const requested = options.authProfile?.trim();
  const provider = requested?.includes(":") ? requested.split(":")[0] : requested;
  const key = provider || "openai-codex";
  const profile = record[key];
  if (!profile) {
    throw new Error(`No ${key} OAuth credential found in ${authPath}`);
  }
  return { profileId: `${key}:default`, profile: { ...profile, provider: key } };
}

function buildAuthResult(params) {
  const accessToken = profileAccess(params.profile);
  const refreshToken = profileRefresh(params.profile);
  const accountId = profileAccountId(params.profile);
  const provider =
    params.profile.provider ??
    (params.profileId?.includes(":") ? params.profileId.split(":")[0] : "openai-codex");

  if (!accessToken) {
    throw new Error(`No access token found in ${params.authPath}`);
  }

  if (!accountId) {
    throw new Error(`No accountId found in ${params.authPath}`);
  }

  const tokenPayload = decodeJwtPayload(accessToken);
  const expiresMs = normalizeExpiresMs(params.profile.expires) ?? (tokenPayload?.exp ? tokenPayload.exp * 1000 : null);

  return {
    accessToken,
    accountId,
    authJson: params.authJson,
    authPath: params.authPath,
    authFormat: params.authFormat,
    authMode: params.authMode ?? null,
    expiresMs,
    lastRefresh: params.lastRefresh ?? null,
    profileId: params.profileId ?? null,
    provider,
    refreshToken,
    tokenPayload,
  };
}

function parseAuthJson(auth, authPath, options = {}) {
  if (auth.tokens && typeof auth.tokens === "object") {
    return buildAuthResult({
      authJson: auth,
      authPath,
      authFormat: "codex-auth-json",
      authMode: auth.auth_mode ?? null,
      lastRefresh: auth.last_refresh ?? null,
      profile: {
        access: auth.tokens.access_token,
        refresh: auth.tokens.refresh_token,
        accountId: auth.tokens.account_id,
      },
    });
  }

  if (auth.profiles && typeof auth.profiles === "object") {
    const { profileId, profile } = selectOpenClawProfile(auth, authPath, options);
    return buildAuthResult({
      authJson: auth,
      authPath,
      authFormat: "openclaw-auth-profiles",
      profileId,
      profile,
    });
  }

  const { profileId, profile } = selectProviderMapProfile(auth, authPath, options);
  return buildAuthResult({
    authJson: auth,
    authPath,
    authFormat: path.basename(authPath) === "oauth.json" ? "openclaw-oauth-json" : "openclaw-legacy-auth-json",
    profileId,
    profile,
  });
}

function tokenSecondsLeft(tokenPayload, expiresMs = null) {
  if (!tokenPayload?.exp) {
    if (!expiresMs) {
      return null;
    }
    return Math.floor((expiresMs - Date.now()) / 1000);
  }

  const now = Math.floor(Date.now() / 1000);
  return tokenPayload.exp - now;
}

function staleRefreshReason(auth, options) {
  const secondsLeft = tokenSecondsLeft(auth.tokenPayload, auth.expiresMs);
  if (secondsLeft !== null) {
    if (secondsLeft <= options.refreshSkewSeconds) {
      return secondsLeft <= 0
        ? "access token expired"
        : `access token expires soon (${secondsLeft}s)`;
    }
    return null;
  }

  if (!auth.lastRefresh) {
    return null;
  }

  const lastRefreshMs = Date.parse(auth.lastRefresh);
  if (Number.isNaN(lastRefreshMs)) {
    return null;
  }

  const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
  if (lastRefreshMs < Date.now() - eightDaysMs) {
    return "last_refresh is older than 8 days";
  }

  return null;
}

async function readPrompt(options) {
  if (options.promptFile) {
    return fs.readFile(options.promptFile, "utf8");
  }

  return options.prompt;
}

function localImageLabelText(index) {
  return `[Image #${index + 1}]`;
}

function localImageOpenTagText(index) {
  return `<image name=${localImageLabelText(index)}>`;
}

function imageCloseTagText() {
  return "</image>";
}

function detectImageMime(bytes, imagePath = "") {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (bytes.length >= 6) {
    const gifHeader = bytes.subarray(0, 6).toString("ascii");
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      return "image/gif";
    }
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";

  return null;
}

async function localImageToInputImage(imagePath, options) {
  const absolutePath = path.resolve(imagePath);
  const bytes = await fs.readFile(absolutePath);
  const mime = detectImageMime(bytes, absolutePath);

  if (!mime) {
    throw new Error(`Unsupported image format for ${absolutePath}. Supported: PNG, JPEG, GIF, WebP.`);
  }

  const imageUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  if (imageUrl.length > LARGE_DATA_URL_WARNING_BYTES) {
    logProgress(
      options,
      `codex-imagen: warning: reference image is large after base64 (${imageUrl.length} bytes): ${absolutePath}`
    );
  }

  return {
    image_url: imageUrl,
    metadata: {
      path: absolutePath,
      bytes: bytes.length,
      mime,
      data_url_bytes: imageUrl.length,
    },
  };
}

function urlToInputImage(imageUrl, options) {
  if (!/^data:image\//i.test(imageUrl) && !/^https?:\/\//i.test(imageUrl)) {
    throw new Error(`--image-url must be http(s) or data:image URL: ${imageUrl}`);
  }

  if (imageUrl.length > LARGE_DATA_URL_WARNING_BYTES) {
    logProgress(
      options,
      `codex-imagen: warning: reference image URL is large (${imageUrl.length} bytes)`
    );
  }

  return {
    image_url: imageUrl,
    metadata: {
      url: /^data:/i.test(imageUrl) ? "data:image/..." : imageUrl,
      data_url_bytes: /^data:/i.test(imageUrl) ? imageUrl.length : null,
    },
  };
}

async function buildPromptContent(options, prompt) {
  const refs = [];

  for (const imagePath of options.imagePaths) {
    refs.push(await localImageToInputImage(imagePath, options));
  }

  for (const imageUrl of options.imageUrls) {
    refs.push(urlToInputImage(imageUrl, options));
  }

  const content = [];
  refs.forEach((ref, index) => {
    content.push({ type: "input_text", text: localImageOpenTagText(index) });
    content.push({
      type: "input_image",
      image_url: ref.image_url,
      detail: options.imageDetail,
    });
    content.push({ type: "input_text", text: imageCloseTagText() });
  });
  content.push({ type: "input_text", text: prompt });

  if (refs.length > 0) {
    logProgress(options, `codex-imagen: attached ${refs.length} reference image(s)`);
    refs.forEach((ref, index) => {
      const source = ref.metadata.path ?? ref.metadata.url ?? "image";
      const size = ref.metadata.bytes ? `, ${ref.metadata.bytes} bytes` : "";
      const mime = ref.metadata.mime ? `, ${ref.metadata.mime}` : "";
      logVerbose(options, `reference ${index + 1}: ${source}${mime}${size}`);
    });
  }

  return content;
}

async function buildResponsesBody(options, prompt, requestId) {
  const content = await buildPromptContent(options, prompt);
  return {
    model: options.model,
    instructions: "",
    input: [
      {
        type: "message",
        role: "user",
        content,
      },
    ],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    prompt_cache_key: requestId,
    stream: options.stream,
    store: false,
    reasoning: null,
  };
}

function buildHeaders(auth, requestId, sessionId) {
  return {
    "accept": "text/event-stream, application/json",
    "authorization": `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    "content-type": "application/json",
    "originator": "codex_cli_rs",
    "session_id": sessionId,
    "user-agent": `codex-imagen/${PACKAGE_VERSION}`,
    "version": "0.122.0",
    "x-client-request-id": requestId,
  };
}

function buildRefreshHeaders() {
  return {
    "accept": "application/json",
    "content-type": "application/json",
    "originator": "codex_cli_rs",
    "user-agent": `codex-imagen/${PACKAGE_VERSION}`,
    "version": "0.122.0",
  };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function refreshErrorCode(body) {
  const parsed = tryParseJson(body);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (typeof parsed.error === "string") {
    return parsed.error;
  }

  if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.code === "string") {
    return parsed.error.code;
  }

  if (typeof parsed.code === "string") {
    return parsed.code;
  }

  return null;
}

function refreshFailureMessage(status, body) {
  const code = refreshErrorCode(body);
  const signInAgain = "Sign in again with Codex or OpenClaw OAuth.";

  if (status === 401) {
    if (code === "refresh_token_expired") {
      return `Refresh token expired. ${signInAgain}`;
    }
    if (code === "refresh_token_reused") {
      return `Refresh token was already used. ${signInAgain}`;
    }
    if (code === "refresh_token_invalidated") {
      return `Refresh token was revoked. ${signInAgain}`;
    }
    return `Refresh token was rejected. ${signInAgain}`;
  }

  const parsed = tryParseJson(body);
  const message =
    parsed?.error?.message ??
    parsed?.error_description ??
    parsed?.message ??
    body.trim() ??
    "(empty response)";
  return `Refresh request failed: HTTP ${status}: ${message}`;
}

function isRefreshTokenReusedResponse(status, body) {
  if (status !== 401) {
    return false;
  }

  if (refreshErrorCode(body) === "refresh_token_reused") {
    return true;
  }

  const text = String(body ?? "").toLowerCase();
  return (
    text.includes("refresh_token_reused") ||
    text.includes("refresh token has already been used") ||
    text.includes("already been used to generate a new access token")
  );
}

function canUseExistingAccessAfterRefreshReuse(auth, reason) {
  if (["forced refresh", "refresh-only", "401 from Codex backend"].includes(reason)) {
    return false;
  }
  const secondsLeft = tokenSecondsLeft(auth.tokenPayload, auth.expiresMs);
  return secondsLeft !== null && secondsLeft > 0;
}

async function writeAuthJsonAtomic(authPath, authJson) {
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(authPath),
    `.${path.basename(authPath)}.${process.pid}.${Date.now()}.tmp`
  );
  const data = `${JSON.stringify(authJson, null, 2)}\n`;
  await fs.writeFile(tempPath, data, { mode: 0o600 });
  await fs.rename(tempPath, authPath);
  try {
    await fs.chmod(authPath, 0o600);
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
  }
}

function mergeRefreshResponse(authJson, refreshResponse) {
  const nextAuthJson = structuredClone(authJson);
  const tokens = nextAuthJson.tokens ?? {};
  nextAuthJson.tokens = tokens;

  if (refreshResponse.id_token) {
    tokens.id_token = refreshResponse.id_token;
  }
  if (refreshResponse.access_token) {
    tokens.access_token = refreshResponse.access_token;
  }
  if (refreshResponse.refresh_token) {
    tokens.refresh_token = refreshResponse.refresh_token;
  }

  nextAuthJson.last_refresh = new Date().toISOString();
  return nextAuthJson;
}

function refreshedExpiresMs(refreshResponse) {
  if (typeof refreshResponse.expires_at === "number") {
    return normalizeExpiresMs(refreshResponse.expires_at);
  }
  if (typeof refreshResponse.expires_in === "number") {
    return Date.now() + refreshResponse.expires_in * 1000;
  }
  const payload = refreshResponse.access_token ? decodeJwtPayload(refreshResponse.access_token) : null;
  return payload?.exp ? payload.exp * 1000 : null;
}

function mergeRefreshResponseForAuth(currentAuth, refreshResponse) {
  if (currentAuth.authFormat === "codex-auth-json") {
    return mergeRefreshResponse(currentAuth.authJson, refreshResponse);
  }

  const nextAuthJson = structuredClone(currentAuth.authJson);
  const profileId = currentAuth.profileId;

  if (currentAuth.authFormat === "openclaw-auth-profiles") {
    const profile = nextAuthJson.profiles?.[profileId];
    if (!profile) {
      throw new Error(`OpenClaw profile disappeared during refresh: ${profileId}`);
    }
    if (refreshResponse.access_token) {
      profile.access = refreshResponse.access_token;
    }
    if (refreshResponse.refresh_token) {
      profile.refresh = refreshResponse.refresh_token;
    }
    const expires = refreshedExpiresMs(refreshResponse);
    if (expires) {
      profile.expires = expires;
    }
    if (refreshResponse.id_token) {
      profile.idToken = refreshResponse.id_token;
    }
    return nextAuthJson;
  }

  const provider = profileId?.includes(":") ? profileId.split(":")[0] : "openai-codex";
  const profile = nextAuthJson[provider];
  if (!profile) {
    throw new Error(`OpenClaw OAuth entry disappeared during refresh: ${provider}`);
  }
  if (refreshResponse.access_token) {
    profile.access = refreshResponse.access_token;
  }
  if (refreshResponse.refresh_token) {
    profile.refresh = refreshResponse.refresh_token;
  }
  const expires = refreshedExpiresMs(refreshResponse);
  if (expires) {
    profile.expires = expires;
  }
  if (refreshResponse.id_token) {
    profile.idToken = refreshResponse.id_token;
  }
  return nextAuthJson;
}

async function postRefreshRequest(options, refreshToken) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), OAUTH_REFRESH_CALL_TIMEOUT_MS);
  try {
    return await fetch(options.refreshUrl, {
      method: "POST",
      headers: buildRefreshHeaders(),
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: abortController.signal,
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(`OAuth refresh exceeded ${OAUTH_REFRESH_CALL_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function authCredentialsChanged(left, right) {
  return (
    left.accessToken !== right.accessToken ||
    left.refreshToken !== right.refreshToken ||
    left.expiresMs !== right.expiresMs ||
    left.lastRefresh !== right.lastRefresh
  );
}

function skipRefreshAfterReload(originalAuth, currentAuth, options, reason) {
  const changed = authCredentialsChanged(originalAuth, currentAuth);
  const fresh = !staleRefreshReason(currentAuth, options);

  if (changed && fresh) {
    return "auth changed";
  }

  if (!["forced refresh", "refresh-only", "401 from Codex backend"].includes(reason) && fresh) {
    return "already fresh";
  }

  return null;
}

async function refreshAuthUnlocked(options, auth, reason, { retryRotatedRefreshToken = true } = {}) {
  logVerbose(options, `refresh: ${reason}`);
  logVerbose(options, `refresh_endpoint: ${options.refreshUrl}`);

  const response = await postRefreshRequest(options, auth.refreshToken);

  if (!response.ok) {
    const body = await response.text();
    const currentAuth = await readAuthWithOptions(auth.authPath, { authProfile: auth.profileId }).catch(() => null);
    if (currentAuth && authCredentialsChanged(auth, currentAuth)) {
      if (!staleRefreshReason(currentAuth, options)) {
        logVerbose(options, "refresh skipped: auth.json changed while refresh was in progress");
        return { auth: currentAuth, refreshed: false, skipped: "auth changed" };
      }
      if (
        retryRotatedRefreshToken &&
        isRefreshTokenReusedResponse(response.status, body) &&
        currentAuth.refreshToken &&
        currentAuth.refreshToken !== auth.refreshToken
      ) {
        logVerbose(options, "refresh retry: auth refresh token changed after refresh_token_reused");
        return refreshAuthUnlocked(options, currentAuth, "refresh_token_reused with rotated refresh token", {
          retryRotatedRefreshToken: false,
        });
      }
    }
    if (isRefreshTokenReusedResponse(response.status, body)) {
      const fallbackAuth = currentAuth ?? auth;
      if (canUseExistingAccessAfterRefreshReuse(fallbackAuth, reason)) {
        logVerbose(options, "refresh skipped: refresh_token_reused but access token is still usable");
        return { auth: fallbackAuth, refreshed: false, skipped: "refresh_token_reused; access token still valid" };
      }
    }
    throw new Error(refreshFailureMessage(response.status, body));
  }

  const refreshResponse = await response.json();
  const currentAuth = await readAuthWithOptions(auth.authPath, { authProfile: auth.profileId });
  if (currentAuth.refreshToken !== auth.refreshToken) {
    logVerbose(options, "refresh skipped: auth.json changed before persist");
    return { auth: currentAuth, refreshed: false, skipped: "auth changed" };
  }

  const nextAuthJson = mergeRefreshResponseForAuth(currentAuth, refreshResponse);
  await writeAuthJsonAtomic(auth.authPath, nextAuthJson);
  const nextAuth = await readAuthWithOptions(auth.authPath, { authProfile: currentAuth.profileId });

  return { auth: nextAuth, refreshed: true, skipped: null };
}

async function refreshOpenClawAuthWithLocks(options, auth, reason) {
  const provider = auth.provider || "openai-codex";
  const refreshLockPath = resolveOpenClawOAuthRefreshLockPath(provider, auth.profileId);

  logVerbose(options, `openclaw_refresh_lock: ${refreshLockPath}`);
  logVerbose(options, `openclaw_auth_store_lock: ${auth.authPath}`);

  try {
    return await withFileLock(refreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () =>
      withFileLock(auth.authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
        const currentAuth = await readAuthWithOptions(auth.authPath, { authProfile: auth.profileId });
        const skipped = skipRefreshAfterReload(auth, currentAuth, options, reason);
        if (skipped) {
          logVerbose(options, `refresh skipped: ${skipped}`);
          return { auth: currentAuth, refreshed: false, skipped };
        }
        return refreshAuthUnlocked(options, currentAuth, reason);
      })
    );
  } catch (error) {
    if (error?.code === FILE_LOCK_TIMEOUT_ERROR_CODE) {
      throw new Error(`Timed out waiting for OpenClaw OAuth refresh lock: ${error.lockPath}`);
    }
    throw error;
  }
}

async function refreshAuth(options, auth, reason) {
  if (!options.refresh) {
    throw new Error(`Codex OAuth refresh is disabled, but refresh is required: ${reason}`);
  }

  if (!auth.refreshToken) {
    throw new Error(`No refresh token found in ${auth.authPath}`);
  }

  if (auth.authFormat === "openclaw-auth-profiles" && auth.profileId) {
    return refreshOpenClawAuthWithLocks(options, auth, reason);
  }

  return refreshAuthUnlocked(options, auth, reason);
}

async function prepareAuth(options) {
  let auth = await readAuthWithOptions(options.authPath, options);

  if (auth.authMode && auth.authMode !== "chatgpt") {
    console.error(`warning: auth_mode is ${auth.authMode}, expected chatgpt.`);
  }

  let refresh = null;
  const reason = options.forceRefresh ? "forced refresh" : staleRefreshReason(auth, options);

  if (reason) {
    refresh = await refreshAuth(options, auth, reason);
    auth = refresh.auth;
  }

  return { auth, refresh };
}

function parseSseEvent(block) {
  const event = { type: "message", data: "" };
  const data = [];

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) {
      continue;
    }

    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    let value = separator === -1 ? "" : rawLine.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      event.type = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  event.data = data.join("\n");
  return event;
}

function collectImageGenerationCalls(value, calls = []) {
  if (!value || typeof value !== "object") {
    return calls;
  }

  if (value.type === "image_generation_call") {
    calls.push(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectImageGenerationCalls(item, calls);
    }
    return calls;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "result" && typeof child === "string") {
      continue;
    }
    collectImageGenerationCalls(child, calls);
  }

  return calls;
}

function mergeImageCall(previous, next) {
  if (!previous) {
    return next;
  }

  const merged = { ...previous, ...next };

  if (previous.result && !next.result) {
    merged.result = previous.result;
  }

  if (previous.revised_prompt && !next.revised_prompt) {
    merged.revised_prompt = previous.revised_prompt;
  }

  if (previous.status === "completed" && next.status !== "completed") {
    merged.status = "completed";
  }

  if (next.status === "completed") {
    merged.status = "completed";
  }

  if (previous.partial === false || next.partial === false) {
    merged.partial = false;
  } else if (previous.partial === true || next.partial === true) {
    merged.partial = true;
  }

  return merged;
}

function imageCallsFromPayload(payload, payloadType) {
  const calls = collectImageGenerationCalls(payload);
  const finalishEvent = payloadType === "response.output_item.done" || payloadType === "response.completed";

  if (payload?.type === "response.image_generation_call.partial_image" && payload.partial_image_b64) {
    calls.push({
      type: "image_generation_call",
      id: payload.item_id ?? null,
      status: "partial_image",
      result: payload.partial_image_b64,
      partial: true,
      partial_image_index: payload.partial_image_index ?? null,
    });
  }

  return calls.map((call) => ({
    ...call,
    partial: call.partial ?? !finalishEvent,
  }));
}

function eventTypeFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return typeof payload;
  }

  return payload.type ?? payload.event ?? payload.item?.type ?? "object";
}

function compactJson(value, maxLength = 1200) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }

  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function normalizeBackendError(source, value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return { source, message: value };
  }

  if (typeof value !== "object") {
    return { source, message: String(value) };
  }

  const message =
    value.message ??
    value.error_description ??
    value.reason ??
    value.detail ??
    value.code ??
    value.status ??
    null;

  return {
    source,
    code: value.code ?? null,
    type: value.type ?? null,
    status: value.status ?? null,
    param: value.param ?? null,
    message: message ? String(message) : compactJson(value),
  };
}

function backendErrorRetryReason(error) {
  const text = [error.code, error.type, error.status, error.message].filter(Boolean).join(" ").toLowerCase();
  if (
    /\b(server_error|internal_error|server_overloaded|service_unavailable|temporarily_unavailable|backend_error)\b/.test(
      text
    ) ||
    text.includes("overloaded") ||
    text.includes("unavailable")
  ) {
    return error.code || error.type || error.status || "backend_error";
  }
  return null;
}

function retryReason(error) {
  if (error instanceof TimeoutError || error instanceof UsageError) {
    return null;
  }

  if (error instanceof HttpStatusError) {
    if (error.status >= 500 && error.status < 600) {
      return `HTTP ${error.status}`;
    }
    return null;
  }

  if (error instanceof GenerationFailedError) {
    for (const backendError of dedupeBackendErrors(error.backendErrors ?? [])) {
      const reason = backendErrorRetryReason(backendError);
      if (reason) {
        return reason;
      }
    }

    const seen = new Set(error.seenEventTypes ?? []);
    if (seen.has("response.failed")) {
      return "response.failed";
    }
    if (error.seenEventTypes?.some((eventType) => eventType.startsWith("unparsed:"))) {
      return "unparsed_stream_event";
    }
    if (error.seenEventTypes?.length === 0) {
      return "empty_response_stream";
    }
    if (
      !seen.has("response.completed") &&
      (seen.has("response.created") ||
        seen.has("response.in_progress") ||
        seen.has("response.output_item.added") ||
        seen.has("response.image_generation_call.in_progress") ||
        seen.has("response.image_generation_call.generating") ||
        seen.has("keepalive"))
    ) {
      return "stream_ended_before_completed_image";
    }

    return null;
  }

  const text = `${error?.name ?? ""} ${error?.message ?? ""} ${error?.cause?.code ?? ""} ${
    error?.cause?.message ?? ""
  }`;
  if (/\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|network|fetch failed)\b/i.test(text)) {
    return "transport";
  }

  return null;
}

function backendErrorsFromPayload(payload, payloadType) {
  const errors = [];
  const add = (source, value) => {
    const normalized = normalizeBackendError(source, value);
    if (normalized) {
      errors.push(normalized);
    }
  };

  if (payloadType === "error" || payload?.error) {
    add("error", payload?.error ?? payload);
  }

  if (payloadType === "response.failed" || payload?.response?.status === "failed") {
    add("response.error", payload?.response?.error);
    add("response.incomplete_details", payload?.response?.incomplete_details);
    if (!payload?.response?.error && !payload?.response?.incomplete_details) {
      add("response.failed", {
        status: payload?.response?.status,
        id: payload?.response?.id,
      });
    }
  }

  add("item.error", payload?.item?.error);

  return errors;
}

function formatBackendError(error) {
  const parts = [error.source];
  if (error.status) parts.push(`status=${error.status}`);
  if (error.code) parts.push(`code=${error.code}`);
  if (error.type) parts.push(`type=${error.type}`);
  if (error.param) parts.push(`param=${error.param}`);
  parts.push(error.message);
  return parts.filter(Boolean).join(" ");
}

function dedupeBackendErrors(errors) {
  const seen = new Set();
  return errors.filter((error) => {
    const key = [error.code, error.param, error.message].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatBackendErrors(errors) {
  return dedupeBackendErrors(errors).map((error) => `  - ${formatBackendError(error)}`).join("\n");
}

async function parseStreamingResponse(response, options, onImageCall, streamState = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  const imageCalls = new Map();
  const seenEventTypes = streamState.seenEventTypes ?? new Set();
  streamState.seenEventTypes = seenEventTypes;
  const progressEvents = new Set();
  const backendErrors = [];

  const noteProgress = (payloadType) => {
    if (progressEvents.has(payloadType)) {
      return;
    }
    progressEvents.add(payloadType);

    if (payloadType === "response.created") {
      logProgress(options, "codex-imagen: request accepted");
    } else if (payloadType === "response.image_generation_call.in_progress") {
      logProgress(options, "codex-imagen: image generation started");
    } else if (payloadType === "response.image_generation_call.generating") {
      logProgress(options, "codex-imagen: image generation running");
    } else if (payloadType === "response.image_generation_call.partial_image") {
      logProgress(options, "codex-imagen: image bytes received");
    } else if (payloadType === "response.completed") {
      logProgress(options, "codex-imagen: response completed");
    }
  };

  const recordImageCall = async (call) => {
    const key = call.id ?? `call-${imageCalls.size + 1}`;
    const merged = mergeImageCall(imageCalls.get(key), call);
    imageCalls.set(key, merged);

    if (onImageCall) {
      await onImageCall(merged, key);
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) {
        break;
      }

      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const sse = parseSseEvent(block);

      if (!sse.data || sse.data === "[DONE]") {
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(sse.data);
      } catch {
        seenEventTypes.add(`unparsed:${sse.type}`);
        continue;
      }

      const payloadType = eventTypeFromPayload(payload);
      seenEventTypes.add(payloadType);
      logVerbose(options, `event: ${payloadType}`);
      noteProgress(payloadType);
      backendErrors.push(...backendErrorsFromPayload(payload, payloadType));

      for (const call of imageCallsFromPayload(payload, payloadType)) {
        await recordImageCall(call);
      }
    }
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }

  if (buffer.trim()) {
    const sse = parseSseEvent(buffer.trim());
    if (sse.data && sse.data !== "[DONE]") {
      try {
        const payload = JSON.parse(sse.data);
        const payloadType = eventTypeFromPayload(payload);
        seenEventTypes.add(payloadType);
        logVerbose(options, `event: ${payloadType}`);
        noteProgress(payloadType);
        backendErrors.push(...backendErrorsFromPayload(payload, payloadType));
        for (const call of imageCallsFromPayload(payload, payloadType)) {
          await recordImageCall(call);
        }
      } catch {
        seenEventTypes.add(`unparsed:${sse.type}`);
      }
    }
  }

  return {
    imageCalls: [...imageCalls.values()],
    seenEventTypes: [...seenEventTypes],
    backendErrors,
  };
}

async function parseJsonResponse(response) {
  const payload = await response.json();
  const payloadType = eventTypeFromPayload(payload);
  return {
    imageCalls: imageCallsFromPayload(payload, payloadType),
    seenEventTypes: [payloadType],
    backendErrors: backendErrorsFromPayload(payload, payloadType),
  };
}

function timestampForPath() {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "")
    .replace("T", "-");
}

function safeCallId(imageCall) {
  return imageCall.id ? imageCall.id.replace(/[^a-zA-Z0-9_.-]/g, "_") : "image";
}

function paddedIndex(index, total) {
  const width = total && total > 1 ? String(total).length : 1;
  return String(index + 1).padStart(width, "0");
}

function autoImageName(imageCall, index, total, timestamp) {
  const imageIndex = total === null || total > 1 ? `${paddedIndex(index, total)}-` : "";
  return `codex-imagen-${timestamp}-${imageIndex}${safeCallId(imageCall)}.png`;
}

function looksLikeDirectoryOutput(output) {
  return output.endsWith("/") || output.endsWith("\\") || path.extname(output) === "";
}

function numberedOutputPath(outputPath, index, total) {
  if (total === 1) {
    return outputPath;
  }

  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}-${paddedIndex(index, total)}${parsed.ext || ".png"}`);
}

function outputPathFor(options, imageCall, index, total, timestamp) {
  if (options.output) {
    const output = path.resolve(options.output);

    if (looksLikeDirectoryOutput(options.output)) {
      return path.join(output, autoImageName(imageCall, index, total, timestamp));
    }

    if (total === null && index === 0) {
      return output;
    }

    return numberedOutputPath(output, index, total);
  }

  return path.resolve(options.outDir, autoImageName(imageCall, index, total, timestamp));
}

async function saveImageCall(options, imageCall, index, total, timestamp) {
  if (!imageCall.result) {
    throw new Error(`Image call ${imageCall.id ?? "(no id)"} had no base64 result`);
  }

  const outputPath = outputPathFor(options, imageCall, index, total, timestamp);
  return writeImageCallToPath(imageCall, outputPath);
}

async function writeImageCallToPath(imageCall, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const bytes = Buffer.from(imageCall.result, "base64");
  await fs.writeFile(outputPath, bytes);

  return {
    path: outputPath,
    decodedPath: outputPath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    call_id: imageCall.id ?? null,
    status: imageCall.status ?? null,
    partial: imageCall.partial ?? null,
    revised_prompt: imageCall.revised_prompt ?? null,
  };
}

async function renumberFirstFileOutputForMulti(options, images) {
  if (!options.output || looksLikeDirectoryOutput(options.output) || images.length !== 1) {
    return;
  }

  const exactOutput = path.resolve(options.output);
  if (images[0].path !== exactOutput) {
    return;
  }

  const numberedOutput = numberedOutputPath(exactOutput, 0, null);
  if (numberedOutput === exactOutput) {
    return;
  }

  await fs.rename(exactOutput, numberedOutput);
  images[0].path = numberedOutput;
  logProgress(options, `codex-imagen: renamed first image for multi-output: ${numberedOutput}`);
}

function createStreamingImageSaver(options) {
  const images = [];
  const savedByKey = new Map();
  const batchTimestamp = timestampForPath();

  return {
    images,
    async maybeSave(imageCall, key) {
      if (!imageCall.result) {
        return null;
      }

      const existing = savedByKey.get(key);
      if (existing) {
        const previousSha = existing.sha256;
        const updated = await writeImageCallToPath(imageCall, existing.path);
        Object.assign(existing, updated);
        if (updated.sha256 !== previousSha) {
          logProgress(options, `codex-imagen: updated image ${images.indexOf(existing) + 1}: ${existing.path}`);
        }
        return existing;
      }

      await renumberFirstFileOutputForMulti(options, images);
      const image = await saveImageCall(options, imageCall, images.length, null, batchTimestamp);
      savedByKey.set(key, image);
      images.push(image);
      logProgress(options, `codex-imagen: saved image ${images.length}: ${image.path}`);
      return image;
    },
  };
}

function buildResult({ requestId, sessionId, endpoint, model, images, seenEventTypes, timedOut = false }) {
  return {
    request_id: requestId,
    session_id: sessionId,
    endpoint,
    model,
    image_count: images.length,
    imageCount: images.length,
    images,
    seen_event_types: seenEventTypes,
    timed_out: timedOut,
  };
}

function createGenerationWatchdog(options, abortController) {
  let forceExit = null;
  const timeout = setTimeout(() => {
    abortController.abort();
    forceExit = setTimeout(() => {
      console.error(
        `codex-imagen: forced exit ${FORCE_EXIT_AFTER_ABORT_MS}ms after timeout; fetch did not settle`
      );
      process.exit(124);
    }, FORCE_EXIT_AFTER_ABORT_MS);
  }, options.timeoutMs);

  timeout.unref?.();

  return {
    clear() {
      clearTimeout(timeout);
      if (forceExit) {
        clearTimeout(forceExit);
      }
    },
  };
}

async function requestImage(options, prompt, auth) {
  const requestId = randomUUID();
  const sessionId = randomUUID();
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/responses`;
  const body = await buildResponsesBody(options, prompt, requestId);
  const streamState = { seenEventTypes: new Set() };
  const streamingSaver = createStreamingImageSaver(options);
  const abortController = new AbortController();
  const watchdog = createGenerationWatchdog(options, abortController);

  logProgress(options, `codex-imagen: POST ${endpoint}`);
  logProgress(options, `codex-imagen: model ${options.model}`);
  logVerbose(options, `request_id: ${requestId}`);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: buildHeaders(auth, requestId, sessionId),
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      const preview = text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
      throw new HttpStatusError(response.status, response.statusText, preview);
    }

    const parsed = options.stream
      ? await parseStreamingResponse(response, options, (call, key) => streamingSaver.maybeSave(call, key), streamState)
      : await parseJsonResponse(response);

    const images = options.stream
      ? streamingSaver.images
      : await saveImageCallsAtEnd(options, parsed.imageCalls);

    if (images.length === 0) {
      const backendErrorText = parsed.backendErrors?.length
        ? `\nBackend error details:\n${formatBackendErrors(parsed.backendErrors)}`
        : "";
      throw new GenerationFailedError(
        `No completed image_generation_call with result found. Seen event types: ${parsed.seenEventTypes.join(", ") || "(none)"}${backendErrorText}`,
        {
          backendErrors: parsed.backendErrors ?? [],
          seenEventTypes: parsed.seenEventTypes,
        }
      );
    }

    return buildResult({
      requestId,
      sessionId,
      endpoint,
      model: options.model,
      images,
      seenEventTypes: parsed.seenEventTypes,
    });
  } catch (error) {
    if (abortController.signal.aborted && streamingSaver.images.length > 0) {
      logProgress(
        options,
        `codex-imagen: timed out after ${describeTimeout(options.timeoutMs)}; returning ${streamingSaver.images.length} saved image(s)`
      );
      return buildResult({
        requestId,
        sessionId,
        endpoint,
        model: options.model,
        images: streamingSaver.images,
        seenEventTypes: [...streamState.seenEventTypes],
        timedOut: true,
      });
    }

    if (abortController.signal.aborted) {
      throw new TimeoutError(
        `Timed out after ${describeTimeout(options.timeoutMs)} before any image was saved.`
      );
    }

    throw error;
  } finally {
    watchdog.clear();
  }
}

async function requestImageWithRetries(options, prompt, auth) {
  const totalAttempts = options.retries + 1;

  for (let attemptIndex = 0; ; attemptIndex += 1) {
    if (totalAttempts > 1) {
      logProgress(options, `codex-imagen: generation attempt ${attemptIndex + 1}/${totalAttempts}`);
    }

    try {
      const result = await requestImage(options, prompt, auth);
      if (attemptIndex > 0) {
        result.retry_attempts = attemptIndex;
        result.retryAttempts = attemptIndex;
      }
      return result;
    } catch (error) {
      const reason = retryReason(error);
      if (!reason || attemptIndex >= options.retries) {
        throw error;
      }

      const retryNumber = attemptIndex + 1;
      const delayMs = retryDelayMs(retryNumber);
      logProgress(
        options,
        `codex-imagen: transient generation failure (${reason}); retrying ${retryNumber}/${options.retries} in ${formatDelay(delayMs)}`
      );
      await sleep(delayMs);
    }
  }
}

async function saveImageCallsAtEnd(options, imageCalls) {
  const callsWithImages = imageCalls.filter((call) => call.result);
  const batchTimestamp = timestampForPath();
  return Promise.all(
    callsWithImages.map((call, index) =>
      saveImageCall(options, call, index, callsWithImages.length, batchTimestamp)
    )
  );
}

class HttpStatusError extends Error {
  constructor(status, statusText, body) {
    super(`HTTP ${status} ${statusText}\n${body}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

function authSummary(auth, options) {
  return {
    auth_path: auth.authPath,
    auth_format: auth.authFormat,
    auth_mode: auth.authMode,
    profile_id: auth.profileId,
    provider: auth.provider,
    account_id: auth.accountId,
    last_refresh: auth.lastRefresh,
    access_token_expires_in_seconds: tokenSecondsLeft(auth.tokenPayload, auth.expiresMs),
    refresh_token_present: Boolean(auth.refreshToken),
    endpoint: `${options.baseUrl.replace(/\/+$/, "")}/responses`,
    model: options.model,
    out_dir: options.outDir,
    retries: options.retries,
    total_attempts: options.retries + 1,
    timeout_seconds: timeoutSeconds(options.timeoutMs),
    timeout_ms: options.timeoutMs,
  };
}

function printSmoke(auth, options) {
  const summary = authSummary(auth, options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  for (const [key, value] of Object.entries(summary)) {
    process.stdout.write(`${key}: ${value ?? ""}\n`);
  }
}

async function main() {
  let options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  if (options.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  options = normalizeOptions(options);

  if (options.smoke) {
    const { auth } = options.forceRefresh
      ? await prepareAuth(options)
      : { auth: await readAuthWithOptions(options.authPath, options) };
    printSmoke(auth, options);
    return;
  }

  let { auth, refresh } = await prepareAuth(options);

  if (options.refreshOnly) {
    if (!refresh) {
      refresh = await refreshAuth(options, auth, "refresh-only");
      auth = refresh.auth;
    }

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            auth_path: auth.authPath,
            refreshed: refresh.refreshed,
            skipped: refresh.skipped,
            auth_format: auth.authFormat,
            auth_mode: auth.authMode,
            profile_id: auth.profileId,
            account_id: auth.accountId,
            last_refresh: auth.lastRefresh,
            access_token_expires_in_seconds: tokenSecondsLeft(auth.tokenPayload, auth.expiresMs),
          },
          null,
          2
        )}\n`
      );
    } else {
      process.stdout.write(`${auth.authPath}\n`);
    }
    return;
  }

  const prompt = await readPrompt(options);
  if (!prompt?.trim()) {
    throw new UsageError("Prompt is required. Pass it positionally, with --prompt, or with --prompt-file.");
  }

  let result;
  try {
    result = await requestImageWithRetries(options, prompt, auth);
  } catch (error) {
    if (!(error instanceof HttpStatusError) || error.status !== 401 || !options.refresh) {
      throw error;
    }

    const retryRefresh = await refreshAuth(options, auth, "401 from Codex backend");
    auth = retryRefresh.auth;
    result = await requestImageWithRetries(options, prompt, auth);
    refresh = retryRefresh;
  }

  if (refresh && options.json) {
    result.auth_refresh = {
      refreshed: refresh.refreshed,
      skipped: refresh.skipped,
      last_refresh: auth.lastRefresh,
      access_token_expires_in_seconds: tokenSecondsLeft(auth.tokenPayload, auth.expiresMs),
    };
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const image of result.images) {
      process.stdout.write(`${image.path}\n`);
    }
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof TimeoutError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 124;
    return;
  }
  if (error instanceof GenerationFailedError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof HttpStatusError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
