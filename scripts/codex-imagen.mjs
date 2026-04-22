#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const MACOS_CODEX_APP_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_EFFORT = "xhigh";
const DEFAULT_TIMEOUT_MS = 600_000;
const VERSION = "0.1.1";

const IMAGE_FEATURE_CONFIG = {
  "features.enable_request_compression": true,
  "features.collaboration_modes": true,
  "features.personality": true,
  "features.fast_mode": true,
  "features.image_generation": true,
  "features.image_detail_original": true,
  "features.apps": true,
  "features.plugins": true,
  "features.tool_search": true,
  "features.tool_suggest": false,
  "features.tool_call_mcp_elicitation": true,
};

const SENSITIVE_KEY =
  /authorization|bearer|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|secret|cookie|chatgpt[_-]?account[_-]?id|session[_-]?id/i;

class CliError extends Error {}

function usage(exitCode = 0) {
  const text = `
Usage:
  node codex-imagen.mjs "make a small watercolor robot"
  node codex-imagen.mjs --prompt "make a small watercolor robot"
  node codex-imagen.mjs --debug "make a small watercolor robot"

Options:
  --prompt <text>                Prompt for the image generation turn.
  --prompt-file <path>           Read the prompt from a UTF-8 text file.
  --codex-bin <path|name>        Codex binary. Overrides CODEX_IMAGEN_CODEX_BIN, CODEX_APP_SERVER_BIN, and CODEX_BIN.
  --imagegen-skill-path <path>   Optional explicit imagegen SKILL.md path.
  --cwd <path>                   Working directory for the Codex thread. Defaults to current directory.
  --out-dir <path>               Where decoded images are written.
  --debug                        Write <out-dir>/codex-imagen.jsonl and diagnostics to stderr.
  --log <path>                   Write a redacted JSON-RPC log to this path.
  --model <id>                   Collaboration-mode model. Defaults to ${DEFAULT_MODEL}.
  --effort <effort>              Reasoning effort. Defaults to ${DEFAULT_EFFORT}.
  --timeout-ms <ms>              Turn timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --smoke                        Initialize app-server and inspect models/skills; do not generate.
  --version                      Print version.
  --help                         Show this help.

Environment:
  CODEX_IMAGEN_CODEX_BIN         Preferred Codex binary path/name.
  CODEX_IMAGEN_OUT_DIR           Preferred output directory.
  CODEX_IMAGEN_LOG               Preferred JSON-RPC log path. Enables debug logging.
  CODEX_IMAGEN_SKILL_PATH        Preferred imagegen SKILL.md path.
  OPENCLAW_OUTPUT_DIR            OpenClaw-provided artifact directory, if set.
  OPENCLAW_AGENT_DIR             Used as <agent>/artifacts/codex-imagen when no output dir is set.
  OPENCLAW_STATE_DIR             Used as <state>/artifacts/codex-imagen when no agent dir is set.
  CODEX_HOME                     Used to find skills/.system/imagegen/SKILL.md.
`.trim();
  console.log(text);
  process.exit(exitCode);
}

function expandEqualsArgs(argv) {
  const out = [];
  for (const arg of argv) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const [flag, ...parts] = arg.split("=");
      out.push(flag, parts.join("="));
    } else {
      out.push(arg);
    }
  }
  return out;
}

function parseArgs(rawArgv) {
  const argv = expandEqualsArgs(rawArgv);
  const opts = {
    prompt: null,
    promptFile: null,
    codexBinInput: null,
    imagegenSkillPathInput: null,
    cwd: process.cwd(),
    outDirInput: null,
    logPathInput: null,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    debug: false,
    smoke: false,
  };
  const rest = [];
  const valueFlags = new Set([
    "--prompt",
    "--prompt-file",
    "--codex-bin",
    "--imagegen-skill-path",
    "--cwd",
    "--out-dir",
    "--log",
    "--model",
    "--effort",
    "--timeout-ms",
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--version") {
      console.log(VERSION);
      process.exit(0);
    }
    if (arg === "--smoke") {
      opts.smoke = true;
      continue;
    }
    if (arg === "--debug") {
      opts.debug = true;
      continue;
    }
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (valueFlags.has(arg)) {
      if (i + 1 >= argv.length) throw new CliError(`Missing value for ${arg}`);
      const value = argv[i + 1];
      i += 1;
      if (arg === "--prompt") opts.prompt = value;
      else if (arg === "--prompt-file") opts.promptFile = value;
      else if (arg === "--codex-bin") opts.codexBinInput = value;
      else if (arg === "--imagegen-skill-path") opts.imagegenSkillPathInput = value;
      else if (arg === "--cwd") opts.cwd = resolveUserPath(value);
      else if (arg === "--out-dir") opts.outDirInput = value;
      else if (arg === "--log") opts.logPathInput = value;
      else if (arg === "--model") opts.model = value;
      else if (arg === "--effort") opts.effort = value;
      else if (arg === "--timeout-ms") opts.timeoutMs = Number.parseInt(value, 10);
      continue;
    }
    if (arg.startsWith("--")) throw new CliError(`Unknown option: ${arg}`);
    rest.push(arg);
  }

  if (opts.promptFile && opts.prompt) {
    throw new CliError("Use either --prompt or --prompt-file, not both");
  }
  if (opts.promptFile) {
    opts.prompt = fs.readFileSync(resolveUserPath(opts.promptFile), "utf8").trim();
  } else if (!opts.prompt && rest.length > 0) {
    opts.prompt = rest.join(" ");
  }
  if (!opts.smoke && !opts.prompt) usage(2);
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new CliError("--timeout-ms must be a positive integer");
  }
  return finalizeOptions(opts);
}

function resolveUserPath(value, baseDir = process.cwd()) {
  if (!value) return value;
  let expanded = String(value);
  const home = os.homedir();
  if (expanded === "~") {
    expanded = home;
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(home, expanded.slice(2));
  }
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function isPathLike(value) {
  return (
    path.isAbsolute(value) ||
    value.startsWith(".") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutable(filePath) {
  if (!isFile(filePath)) return false;
  if (process.platform === "win32") return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getPathEnv(env = process.env) {
  if (env.PATH) return env.PATH;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return pathKey ? env[pathKey] : "";
}

function splitPathEnv(pathEnv) {
  return String(pathEnv || "")
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function executableNames(command) {
  if (process.platform !== "win32" || path.extname(command)) return [command];
  const extNames = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .flatMap((ext) => [ext.toLowerCase(), ext.toUpperCase()]);
  return [command, ...extNames.map((ext) => `${command}${ext}`)];
}

function findExecutableInDirs(command, dirs) {
  const names = executableNames(command);
  for (const entry of dirs) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function findExecutableOnPath(command) {
  const pathEntries = splitPathEnv(getPathEnv());
  return findExecutableInDirs(command, pathEntries);
}

function cmdQuote(value) {
  const text = String(value);
  if (text.includes('"')) {
    throw new CliError(`Windows command path/argument contains an unsupported quote character: ${text}`);
  }
  return `"${text}"`;
}

function buildSpawnCommand(command, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const commandLine = [command, ...args].map(cmdQuote).join(" ");
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
    };
  }
  return { command, args };
}

function spawnSyncPortable(command, args, options = {}) {
  const built = buildSpawnCommand(command, args);
  return spawnSync(built.command, built.args, {
    ...options,
    windowsHide: true,
  });
}

function npmGlobalPrefix() {
  const npmBin = findExecutableOnPath("npm");
  if (!npmBin) return null;
  const result = spawnSyncPortable(npmBin, ["config", "get", "prefix"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const prefix = String(result.stdout || "").trim();
  if (!prefix || prefix === "undefined" || prefix === "null") return null;
  return prefix;
}

function platformCodexReleaseNames() {
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? ["codex-aarch64-apple-darwin", "codex"]
      : ["codex-x86_64-apple-darwin", "codex"];
  }
  if (process.platform === "linux") {
    return process.arch === "arm64"
      ? ["codex-aarch64-unknown-linux-musl", "codex"]
      : ["codex-x86_64-unknown-linux-musl", "codex"];
  }
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? ["codex-aarch64-pc-windows-msvc.exe", "codex"]
      : ["codex-x86_64-pc-windows-msvc.exe", "codex"];
  }
  return ["codex"];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function codexCandidateDirs() {
  const dirs = [];
  const npmPrefix = npmGlobalPrefix();
  if (npmPrefix) {
    dirs.push(process.platform === "win32" ? npmPrefix : path.join(npmPrefix, "bin"));
  }

  dirs.push(...splitPathEnv(getPathEnv()));

  const nodeDir = path.dirname(process.execPath);
  dirs.push(nodeDir);

  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : null);
    const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : null);
    dirs.push(
      appData ? path.join(appData, "npm") : null,
      localAppData ? path.join(localAppData, "Microsoft", "WindowsApps") : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : null,
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "nodejs") : null,
    );
  } else {
    dirs.push(
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/snap/bin",
    );
  }

  return uniqueStrings(dirs.map((dir) => (dir ? resolveUserPath(dir) : null)));
}

function findCodexBinaryInKnownLocations() {
  const dirs = codexCandidateDirs();
  for (const name of platformCodexReleaseNames()) {
    const found = findExecutableInDirs(name, dirs);
    if (found) return { path: found, source: name === "codex" ? "auto-detected PATH/npm/common dirs" : `auto-detected release binary ${name}` };
  }
  return null;
}

function formatCodexSearchHint() {
  const dirs = codexCandidateDirs().slice(0, 20);
  return dirs.length > 0 ? ` Checked: ${dirs.join(", ")}` : "";
}

function buildChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (process.platform === "win32") {
    const pathValue = getPathEnv(env);
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
    if (pathValue) env.PATH = pathValue;
  }
  return env;
}

function resolveExecutable(input) {
  if (!input) return null;
  if (isPathLike(input)) {
    const resolved = resolveUserPath(input);
    return isExecutable(resolved) ? resolved : null;
  }
  return findExecutableOnPath(input);
}

function resolveCodexBin(input) {
  const configured = [
    ["--codex-bin", input],
    ["CODEX_IMAGEN_CODEX_BIN", process.env.CODEX_IMAGEN_CODEX_BIN],
    ["CODEX_APP_SERVER_BIN", process.env.CODEX_APP_SERVER_BIN],
    ["CODEX_BIN", process.env.CODEX_BIN],
  ].filter(([, value]) => value);

  for (const [source, value] of configured) {
    const resolved = resolveExecutable(value);
    if (!resolved) {
      throw new CliError(
        `Codex binary from ${source} was not found: ${value}. Install Codex CLI, open Codex Desktop, or pass --codex-bin.${formatCodexSearchHint()}`,
      );
    }
    return { path: resolved, source };
  }

  if (process.platform === "darwin" && isExecutable(MACOS_CODEX_APP_BIN)) {
    return { path: MACOS_CODEX_APP_BIN, source: "macOS Codex.app" };
  }

  const fromPath = resolveExecutable("codex");
  if (fromPath) return { path: fromPath, source: "PATH" };

  const detected = findCodexBinaryInKnownLocations();
  if (detected) return detected;

  throw new CliError(
    `Could not find a Codex binary. Install Codex CLI, open Codex Desktop, or pass --codex-bin / set CODEX_IMAGEN_CODEX_BIN.${formatCodexSearchHint()}`,
  );
}

function resolveOutputDir(input) {
  const candidates = [
    ["--out-dir", input],
    ["CODEX_IMAGEN_OUT_DIR", process.env.CODEX_IMAGEN_OUT_DIR],
    ["OPENCLAW_OUTPUT_DIR", process.env.OPENCLAW_OUTPUT_DIR],
  ].filter(([, value]) => value);
  if (candidates.length > 0) {
    const [source, value] = candidates[0];
    return { path: resolveUserPath(value), source };
  }
  if (process.env.OPENCLAW_AGENT_DIR) {
    return {
      path: path.join(resolveUserPath(process.env.OPENCLAW_AGENT_DIR), "artifacts", "codex-imagen"),
      source: "OPENCLAW_AGENT_DIR",
    };
  }
  if (process.env.OPENCLAW_STATE_DIR) {
    return {
      path: path.join(resolveUserPath(process.env.OPENCLAW_STATE_DIR), "artifacts", "codex-imagen"),
      source: "OPENCLAW_STATE_DIR",
    };
  }
  return { path: path.resolve(process.cwd(), "codex-imagen-output"), source: "cwd" };
}

function resolveLogPath(input, outDir, debug) {
  const candidates = [
    ["--log", input],
    ["CODEX_IMAGEN_LOG", process.env.CODEX_IMAGEN_LOG],
  ].filter(([, value]) => value);
  if (candidates.length > 0) {
    const [source, value] = candidates[0];
    return { path: resolveUserPath(value), source, enabled: true };
  }
  if (debug) {
    return { path: path.join(outDir, "codex-imagen.jsonl"), source: "--debug", enabled: true };
  }
  return { path: null, source: null, enabled: false };
}

function resolveImagegenSkillPath(input) {
  const checked = [];
  const explicit = [
    ["--imagegen-skill-path", input],
    ["CODEX_IMAGEN_SKILL_PATH", process.env.CODEX_IMAGEN_SKILL_PATH],
  ].filter(([, value]) => value);

  for (const [source, value] of explicit) {
    const candidate = resolveUserPath(value);
    const exists = isFile(candidate);
    checked.push({ source, path: candidate, exists });
    if (exists) return { path: candidate, source, checked };
    return { path: null, source: null, checked };
  }

  const codexHome = process.env.CODEX_HOME ? resolveUserPath(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  const candidates = [
    ["CODEX_HOME/default", path.join(codexHome, "skills", ".system", "imagegen", "SKILL.md")],
    ["home/default", path.join(os.homedir(), ".codex", "skills", ".system", "imagegen", "SKILL.md")],
  ];
  const seen = new Set();
  for (const [source, candidate] of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const exists = isFile(candidate);
    checked.push({ source, path: candidate, exists });
    if (exists) return { path: candidate, source, checked };
  }
  return { path: null, source: null, checked };
}

function finalizeOptions(raw) {
  const codexBin = resolveCodexBin(raw.codexBinInput);
  const outDir = resolveOutputDir(raw.outDirInput);
  const logPath = resolveLogPath(raw.logPathInput, outDir.path, raw.debug);
  const imagegenSkillPath = resolveImagegenSkillPath(raw.imagegenSkillPathInput);
  const warnings = [];

  if (!imagegenSkillPath.path) {
    warnings.push(
      "No local imagegen SKILL.md was found. The script will still send a $imagegen prompt, but generation may fail if this Codex install cannot resolve the built-in skill automatically.",
    );
  }

  return {
    ...raw,
    codexBin: codexBin.path,
    codexBinSource: codexBin.source,
    outDir: outDir.path,
    outDirSource: outDir.source,
    logPath: logPath.path,
    logPathSource: logPath.source,
    debug: raw.debug || logPath.enabled,
    imagegenSkillPath: imagegenSkillPath.path,
    imagegenSkillPathSource: imagegenSkillPath.source,
    imagegenSkillPathChecked: imagegenSkillPath.checked,
    warnings,
  };
}

function looksLikeImagePayload(value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("data:image/")) return true;
  if (value.startsWith("iVBORw0KGgo")) return true;
  if (value.startsWith("/9j/")) return true;
  if (value.length < 4096) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(value.slice(0, 2048));
}

function scrub(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (looksLikeImagePayload(value)) {
      return { __redacted: "image_or_large_base64_string", length: value.length };
    }
    if (value.length > 1200) {
      return {
        __truncated_string: true,
        length: value.length,
        prefix: value.slice(0, 240),
      };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = scrub(childValue, childKey);
    }
    return out;
  }
  return value;
}

function decodeImagePayload(payload) {
  if (!payload || typeof payload !== "string") return null;
  let base64 = payload;
  let ext = "png";
  let mimeType = "image/png";
  const match = payload.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (match) {
    mimeType = match[1];
    base64 = match[2];
    ext = mimeType.split("/")[1] || ext;
  }
  base64 = base64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { bytes, ext: "png", mimeType: "image/png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { bytes, ext: "jpg", mimeType: "image/jpeg" };
  }
  if (bytes.length > 0) return { bytes, ext, mimeType };
  return null;
}

function safeFileStem(value) {
  return String(value || `image-${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160);
}

function uniqueImagePath(outDir, stem, ext) {
  let candidate = path.join(outDir, `${stem}.${ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outDir, `${stem}-${index}.${ext}`);
    index += 1;
  }
  return candidate;
}

function debugLog(opts, message) {
  if (opts.debug) console.error(`[codex-imagen] ${message}`);
}

class CodexAppServerClient {
  constructor(opts) {
    this.opts = opts;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.notifications = [];
    this.notificationHandler = null;
    this.closed = false;
    this.logStream = null;
    if (opts.logPath) {
      fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
      this.logStream = fs.createWriteStream(opts.logPath, { flags: "a", mode: 0o600 });
    }
  }

  start() {
    const spawnOptions = {
      cwd: this.opts.cwd,
      env: buildChildEnv({ CODEX_CLI_PATH: this.opts.codexBin }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    const built = buildSpawnCommand(this.opts.codexBin, ["app-server", "--listen", "stdio://"]);
    this.proc = spawn(built.command, built.args, spawnOptions);
    this.writeLog({
      event: "spawn",
      pid: process.pid,
      childPid: this.proc.pid,
      codexBin: this.opts.codexBin,
      codexBinSource: this.opts.codexBinSource,
      cwd: this.opts.cwd,
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      this.writeLog({ direction: "appserver_stderr", text: chunk });
    });
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const error = code === 0 ? null : new Error(`app-server exited: code=${code} signal=${signal || ""}`);
      for (const { reject } of this.pending.values()) {
        reject(error || new Error("app-server exited"));
      }
      this.pending.clear();
    });
    this.proc.on("error", (error) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
  }

  writeLog(record) {
    if (!this.logStream) return;
    this.logStream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...scrub(record) })}\n`);
  }

  send(message) {
    if (this.closed) throw new Error("app-server client is closed");
    const line = JSON.stringify(message);
    this.writeLog({ direction: "client_to_appserver", frame: message });
    this.proc.stdin.write(`${line}\n`);
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.send({ id, method, params });
    return promise;
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (error) {
      this.writeLog({ direction: "appserver_to_client", parseError: String(error?.message || error), line });
      return;
    }
    this.writeLog({ direction: "appserver_to_client", frame: msg });
    if (msg.id !== undefined && msg.method) {
      this.handleServerRequest(msg);
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || pending.method), { data: msg.error }));
      else pending.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      this.notifications.push(msg);
      this.notificationHandler?.(msg);
    }
  }

  handleServerRequest(msg) {
    let result;
    if (msg.method === "item/commandExecution/requestApproval") {
      result = { decision: "decline" };
    } else if (msg.method === "item/fileChange/requestApproval") {
      result = { decision: "decline" };
    } else if (msg.method === "item/tool/requestUserInput") {
      result = { answers: {} };
    } else if (msg.method === "mcpServer/elicitation/request") {
      result = { action: "decline", content: null, _meta: null };
    } else if (msg.method === "item/tool/call") {
      result = {
        success: false,
        contentItems: [{ type: "inputText", text: `Dynamic tool ${msg.params?.tool || ""} is not implemented by codex-imagen.` }],
      };
    } else {
      this.send({
        id: msg.id,
        error: { code: -32601, message: `Unsupported server request: ${msg.method}` },
      });
      return;
    }
    this.send({ id: msg.id, result });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rl?.close();
    this.proc?.stdin?.end();
    if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.logStream?.end();
  }
}

function buildInput(prompt, opts) {
  const input = [{ type: "text", text: `$imagegen ${prompt}`, text_elements: [] }];
  if (opts.imagegenSkillPath) {
    input.push({ type: "skill", name: "imagegen", path: opts.imagegenSkillPath });
  }
  return input;
}

function saveImageItem(item, outDir) {
  const payload = item.result;
  const decoded = decodeImagePayload(payload);
  if (!decoded) {
    return {
      id: item.id,
      status: item.status,
      revisedPrompt: item.revisedPrompt ?? item.revised_prompt ?? null,
      savedPath: item.savedPath ?? item.saved_path ?? null,
      decodedPath: null,
      error: "no decodable base64 result",
    };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const stem = safeFileStem(item.id);
  const decodedPath = uniqueImagePath(outDir, stem, decoded.ext);
  fs.writeFileSync(decodedPath, decoded.bytes, { mode: 0o600 });
  return {
    id: item.id,
    status: item.status,
    revisedPrompt: item.revisedPrompt ?? item.revised_prompt ?? null,
    savedPath: item.savedPath ?? item.saved_path ?? null,
    decodedPath,
    mimeType: decoded.mimeType,
    bytes: decoded.bytes.length,
  };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "TURN_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });
  debugLog(opts, `using Codex binary: ${opts.codexBin} (${opts.codexBinSource})`);
  debugLog(opts, `writing images to: ${opts.outDir}`);
  if (opts.logPath) debugLog(opts, `writing redacted app-server trace to: ${opts.logPath}`);
  const client = new CodexAppServerClient(opts);
  client.start();

  try {
    const initialize = await client.request("initialize", {
      clientInfo: {
        name: "codex_imagen",
        title: "Codex Imagen",
        version: VERSION,
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});

    if (opts.smoke) {
      const [models, skills] = await Promise.all([
        client.request("model/list", { limit: 50, includeHidden: false }).catch((error) => ({ error: error.message })),
        client
          .request("skills/list", { cwds: [opts.cwd], forceReload: true })
          .catch((error) => ({ error: error.message })),
      ]);
      const imagegenSkill = skills?.data
        ?.flatMap((entry) => entry.skills || [])
        .find((skill) => skill.name === "imagegen");
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "smoke",
            codexBin: opts.codexBin,
            codexBinSource: opts.codexBinSource,
            userAgent: initialize.userAgent || null,
            modelCount: models?.data?.length ?? null,
            imagegenSkill: imagegenSkill
              ? { name: imagegenSkill.name, path: imagegenSkill.path, enabled: imagegenSkill.enabled }
              : null,
            configuredImagegenSkillPath: opts.imagegenSkillPath,
            usedSkillItem: Boolean(opts.imagegenSkillPath),
            checkedImagegenSkillPaths: opts.imagegenSkillPathChecked,
            outDir: opts.outDir,
            outDirSource: opts.outDirSource,
            logPath: opts.logPath,
            logPathSource: opts.logPathSource,
            debug: opts.debug,
            warnings: opts.warnings,
          },
          null,
          2,
        ),
      );
      return;
    }

    const state = {
      threadId: null,
      turnId: null,
      turn: null,
      errors: [],
      imageItems: [],
      rawImageItems: [],
      agentMessages: [],
      completed: false,
    };

    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });

    client.notificationHandler = (msg) => {
      const params = msg.params || {};
      if (msg.method === "turn/started") {
        state.turnId ||= params.turn?.id || null;
      } else if (msg.method === "error") {
        state.errors.push(params.error || params);
      } else if (msg.method === "item/completed") {
        const item = params.item || {};
        if (item.type === "imageGeneration") {
          const saved = saveImageItem(item, opts.outDir);
          state.imageItems.push(saved);
          if (saved.decodedPath) debugLog(opts, `saved image: ${saved.decodedPath}`);
        } else if (item.type === "agentMessage" && typeof item.text === "string") {
          state.agentMessages.push(item.text);
        }
      } else if (msg.method === "rawResponseItem/completed") {
        const item = params.item || {};
        if (item.type === "image_generation_call") {
          const normalized = {
            type: "imageGeneration",
            id: item.id,
            status: item.status,
            revisedPrompt: item.revised_prompt ?? null,
            result: item.result,
          };
          const saved = saveImageItem(normalized, opts.outDir);
          state.rawImageItems.push(saved);
          if (saved.decodedPath) debugLog(opts, `saved raw image: ${saved.decodedPath}`);
        }
      } else if (msg.method === "turn/completed") {
        state.completed = true;
        state.turn = params.turn || null;
        state.turnId ||= params.turn?.id || null;
        resolveDone();
      }
    };

    const threadResponse = await client.request("thread/start", {
      model: opts.model,
      modelProvider: null,
      serviceTier: "fast",
      cwd: opts.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      config: IMAGE_FEATURE_CONFIG,
      serviceName: "codex_imagen",
      personality: "pragmatic",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    state.threadId = threadResponse.thread?.id || null;
    if (!state.threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(threadResponse)}`);

    const turnResponse = await client.request("turn/start", {
      threadId: state.threadId,
      input: buildInput(opts.prompt, opts),
      cwd: opts.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: null,
      serviceTier: "fast",
      effort: null,
      summary: "auto",
      personality: "pragmatic",
      outputSchema: null,
      collaborationMode: {
        mode: "default",
        settings: {
          model: opts.model,
          reasoning_effort: opts.effort,
          developer_instructions: null,
        },
      },
    });
    state.turnId ||= turnResponse.turn?.id || null;

    let timedOut = false;
    let timeoutMessage = null;
    try {
      await withTimeout(done, opts.timeoutMs, "image generation turn");
    } catch (error) {
      if (error?.code !== "TURN_TIMEOUT") throw error;
      timedOut = true;
      timeoutMessage = error.message;
      debugLog(opts, timeoutMessage);
    }
    const imageCount = state.imageItems.length + state.rawImageItems.length;
    const ok = state.errors.length === 0 && imageCount > 0;

    console.log(
      JSON.stringify(
        {
          ok,
          timedOut,
          timeoutMessage,
          imageCount,
          threadId: state.threadId,
          turnId: state.turnId,
          turnStatus: state.turn?.status || null,
          images: state.imageItems,
          rawImages: state.rawImageItems,
          errors: state.errors,
          agentMessages: state.agentMessages.filter(Boolean),
          codexBin: opts.codexBin,
          codexBinSource: opts.codexBinSource,
          usedSkillItem: Boolean(opts.imagegenSkillPath),
          imagegenSkillPath: opts.imagegenSkillPath,
          outDir: opts.outDir,
          outDirSource: opts.outDirSource,
          logPath: opts.logPath,
          logPathSource: opts.logPathSource,
          debug: opts.debug,
          warnings: opts.warnings,
        },
        null,
        2,
      ),
    );
    if (timedOut) {
      process.exitCode = imageCount > 0 ? 4 : 124;
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
});
