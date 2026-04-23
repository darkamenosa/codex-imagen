import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const scriptPath = path.resolve("scripts", "codex-imagen.mjs");

function jwtWithExpiry(expiresMs) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: Math.floor(expiresMs / 1000) })}.sig`;
}

async function writeOpenClawAuthProfile(authPath, profile) {
  await writeOpenClawAuthProfiles(authPath, { "openai-codex:default": profile });
}

async function writeOpenClawAuthProfiles(authPath, profiles) {
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  await fs.writeFile(
    authPath,
    `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`,
    "utf8"
  );
}

async function writeCodexAuthJson(codexHome, tokens) {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          access_token: tokens.access,
          refresh_token: tokens.refresh,
          account_id: tokens.accountId,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function readOpenClawAuthProfile(authPath) {
  const parsed = JSON.parse(await fs.readFile(authPath, "utf8"));
  return parsed.profiles["openai-codex:default"];
}

async function runCli(args, env = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

test("smoke prefers OpenClaw configured openai-codex profile over default", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-imagen-active-openclaw-profile-"));
  const stateDir = path.join(tempDir, "state");
  const authPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  const configuredProfileId = "openai-codex:hxtxmu@gmail.com";

  await writeOpenClawAuthProfiles(authPath, {
    "openai-codex:default": {
      type: "oauth",
      provider: "openai-codex",
      access: jwtWithExpiry(Date.now() - 20 * 24 * 60 * 60_000),
      refresh: "stale-default-refresh-token",
      expires: Date.now() - 20 * 24 * 60 * 60_000,
      accountId: "acct_test",
    },
    [configuredProfileId]: {
      type: "oauth",
      provider: "openai-codex",
      access: jwtWithExpiry(Date.now() + 60 * 60_000),
      refresh: "fresh-configured-refresh-token",
      expires: Date.now() + 60 * 60_000,
      accountId: "acct_test",
      email: "hxtxmu@gmail.com",
    },
  });
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    `${JSON.stringify(
      {
        auth: {
          profiles: {
            [configuredProfileId]: { provider: "openai-codex" },
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runCli(["--smoke", "--json"], {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_DIR: "",
    PI_CODING_AGENT_DIR: "",
    CODEX_IMAGEN_AUTH_JSON: "",
    OPENCLAW_CODEX_AUTH_JSON: "",
    CODEX_AUTH_JSON: "",
    CODEX_HOME: path.join(tempDir, "missing-codex-home"),
  });

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.profile_id, configuredProfileId);
  assert.equal(output.email, "hxtxmu@gmail.com");
  assert.ok(output.access_token_expires_in_seconds > 0);
});

test("explicit custom auth path is not reordered by unrelated OpenClaw config", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-imagen-explicit-auth-profile-order-"));
  const stateDir = path.join(tempDir, "state");
  const authPath = path.join(tempDir, "custom", "auth-profiles.json");
  const configuredProfileId = "openai-codex:hxtxmu@gmail.com";

  await writeOpenClawAuthProfiles(authPath, {
    "openai-codex:default": {
      type: "oauth",
      provider: "openai-codex",
      access: jwtWithExpiry(Date.now() + 60 * 60_000),
      refresh: "fresh-default-refresh-token",
      expires: Date.now() + 60 * 60_000,
      accountId: "acct_test",
    },
    [configuredProfileId]: {
      type: "oauth",
      provider: "openai-codex",
      access: jwtWithExpiry(Date.now() + 60 * 60_000),
      refresh: "fresh-configured-refresh-token",
      expires: Date.now() + 60 * 60_000,
      accountId: "acct_test",
      email: "hxtxmu@gmail.com",
    },
  });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    `${JSON.stringify(
      {
        auth: {
          profiles: {
            [configuredProfileId]: { provider: "openai-codex" },
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runCli(["--auth", authPath, "--smoke", "--json"], {
    OPENCLAW_STATE_DIR: stateDir,
    CODEX_HOME: path.join(tempDir, "missing-codex-home"),
  });

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.profile_id, "openai-codex:default");
});

async function withRefreshServer(handler, fn) {
  let requests = 0;
  const seenRefreshTokens = [];
  const server = createServer(async (request, response) => {
    requests += 1;
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
    }
    const body = JSON.parse(raw || "{}");
    seenRefreshTokens.push(body.refresh_token);
    await handler({ request, response, body, requests });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await fn({
      url: `http://127.0.0.1:${port}/oauth/token`,
      getRequests: () => requests,
      seenRefreshTokens,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function reusedRefreshTokenResponse(response) {
  response.writeHead(401, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        message: "Your refresh token has already been used to generate a new access token.",
        code: "refresh_token_reused",
      },
    })
  );
}

function reusedRefreshTokenMessageOnlyResponse(response) {
  response.writeHead(401, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        message: "Your refresh token has already been used to generate a new access token.",
      },
    })
  );
}

function writeImageGenerationResponse(response) {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "ig_test",
        status: "completed",
        result: png,
      },
    })}\n\n`
  );
  response.write(`data: ${JSON.stringify({ type: "response.completed" })}\n\n`);
  response.end();
}

test("refresh-only retries once with a rotated refresh token after refresh_token_reused", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-imagen-refresh-reused-"));
  const authPath = path.join(tempDir, "agent", "auth-profiles.json");
  const stateDir = path.join(tempDir, "state");
  const expiredAccess = jwtWithExpiry(Date.now() - 60_000);
  await writeOpenClawAuthProfile(authPath, {
    type: "oauth",
    provider: "openai-codex",
    access: expiredAccess,
    refresh: "old-refresh-token",
    expires: Date.now() - 60_000,
    accountId: "acct_test",
  });

  await withRefreshServer(
    async ({ response, body, requests }) => {
      if (requests === 1) {
        assert.equal(body.refresh_token, "old-refresh-token");
        await writeOpenClawAuthProfile(authPath, {
          type: "oauth",
          provider: "openai-codex",
          access: expiredAccess,
          refresh: "rotated-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "acct_test",
        });
        reusedRefreshTokenResponse(response);
        return;
      }

      assert.equal(body.refresh_token, "rotated-refresh-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: jwtWithExpiry(Date.now() + 60 * 60_000),
          refresh_token: "final-refresh-token",
          expires_in: 3600,
        })
      );
    },
    async ({ url, getRequests, seenRefreshTokens }) => {
      const result = await runCli(
        [
          "--auth",
          authPath,
          "--auth-profile",
          "openai-codex:default",
          "--refresh-url",
          url,
          "--refresh-only",
          "--json",
        ],
        { OPENCLAW_STATE_DIR: stateDir }
      );

      assert.equal(result.code, 0, result.stderr);
      assert.equal(getRequests(), 2);
      assert.deepEqual(seenRefreshTokens, ["old-refresh-token", "rotated-refresh-token"]);
      const output = JSON.parse(result.stdout);
      assert.equal(output.refreshed, true);
      const persisted = await readOpenClawAuthProfile(authPath);
      assert.equal(persisted.refresh, "final-refresh-token");
      assert.ok(persisted.expires > Date.now());
    }
  );
});

test("generation uses still-valid access token when proactive refresh gets refresh_token_reused", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-imagen-refresh-valid-access-"));
  const authPath = path.join(tempDir, "agent", "auth-profiles.json");
  const stateDir = path.join(tempDir, "state");
  const outDir = path.join(tempDir, "out");
  const soonButValidAccess = jwtWithExpiry(Date.now() + 30_000);
  await writeOpenClawAuthProfile(authPath, {
    type: "oauth",
    provider: "openai-codex",
    access: soonButValidAccess,
    refresh: "already-used-refresh-token",
    expires: Date.now() + 30_000,
    accountId: "acct_test",
  });

  let refreshRequests = 0;
  let generationRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/oauth/token") {
      refreshRequests += 1;
      reusedRefreshTokenResponse(response);
      return;
    }
    if (request.url === "/backend-api/codex/responses") {
      generationRequests += 1;
      writeImageGenerationResponse(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await runCli(
      [
        "--auth",
        authPath,
        "--auth-profile",
        "openai-codex:default",
        "--refresh-url",
        `http://127.0.0.1:${port}/oauth/token`,
        "--base-url",
        `http://127.0.0.1:${port}/backend-api/codex`,
        "--out-dir",
        outDir,
        "--json",
        "--prompt",
        "generate one test image",
      ],
      { OPENCLAW_STATE_DIR: stateDir }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(refreshRequests, 1);
    assert.equal(generationRequests, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image_count, 1);
    assert.equal(output.auth_refresh.refreshed, false);
    assert.equal(output.auth_refresh.skipped, "refresh_token_reused; access token still valid");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("refresh_token_reused recovery also works when OAuth response only has message text", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-imagen-refresh-message-only-"));
  const authPath = path.join(tempDir, "agent", "auth-profiles.json");
  const stateDir = path.join(tempDir, "state");
  const outDir = path.join(tempDir, "out");
  const soonButValidAccess = jwtWithExpiry(Date.now() + 30_000);
  await writeOpenClawAuthProfile(authPath, {
    type: "oauth",
    provider: "openai-codex",
    access: soonButValidAccess,
    refresh: "already-used-refresh-token",
    expires: Date.now() + 30_000,
    accountId: "acct_test",
  });

  let refreshRequests = 0;
  let generationRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/oauth/token") {
      refreshRequests += 1;
      reusedRefreshTokenMessageOnlyResponse(response);
      return;
    }
    if (request.url === "/backend-api/codex/responses") {
      generationRequests += 1;
      writeImageGenerationResponse(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await runCli(
      [
        "--auth",
        authPath,
        "--auth-profile",
        "openai-codex:default",
        "--refresh-url",
        `http://127.0.0.1:${port}/oauth/token`,
        "--base-url",
        `http://127.0.0.1:${port}/backend-api/codex`,
        "--out-dir",
        outDir,
        "--json",
        "--quiet",
        "--prompt",
        "generate one test image",
      ],
      { OPENCLAW_STATE_DIR: stateDir }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(refreshRequests, 1);
    assert.equal(generationRequests, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image_count, 1);
    assert.equal(output.auth_refresh.skipped, "refresh_token_reused; access token still valid");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("generation inherits fresh main OpenClaw auth after refresh_token_reused", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-imagen-refresh-main-adopt-"));
  const stateDir = path.join(tempDir, "state");
  const authPath = path.join(stateDir, "agents", "sub", "agent", "auth-profiles.json");
  const mainAuthPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  const outDir = path.join(tempDir, "out");
  const expiredAccess = jwtWithExpiry(Date.now() - 60_000);
  const freshMainAccess = jwtWithExpiry(Date.now() + 60 * 60_000);
  await writeOpenClawAuthProfile(authPath, {
    type: "oauth",
    provider: "openai-codex",
    access: expiredAccess,
    refresh: "already-used-refresh-token",
    expires: Date.now() - 60_000,
    accountId: "acct_test",
  });

  let refreshRequests = 0;
  let generationRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/oauth/token") {
      refreshRequests += 1;
      await writeOpenClawAuthProfile(mainAuthPath, {
        type: "oauth",
        provider: "openai-codex",
        access: freshMainAccess,
        refresh: "fresh-main-refresh-token",
        expires: Date.now() + 60 * 60_000,
        accountId: "acct_test",
      });
      reusedRefreshTokenResponse(response);
      return;
    }
    if (request.url === "/backend-api/codex/responses") {
      generationRequests += 1;
      writeImageGenerationResponse(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await runCli(
      [
        "--auth",
        authPath,
        "--auth-profile",
        "openai-codex:default",
        "--refresh-url",
        `http://127.0.0.1:${port}/oauth/token`,
        "--base-url",
        `http://127.0.0.1:${port}/backend-api/codex`,
        "--out-dir",
        outDir,
        "--json",
        "--quiet",
        "--prompt",
        "generate one test image",
      ],
      { OPENCLAW_STATE_DIR: stateDir }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(refreshRequests, 1);
    assert.equal(generationRequests, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image_count, 1);
    assert.equal(output.auth_refresh.refreshed, false);
    assert.equal(output.auth_refresh.skipped, "inherited fresh OpenClaw main auth");
    const persisted = await readOpenClawAuthProfile(authPath);
    assert.equal(persisted.access, freshMainAccess);
    assert.equal(persisted.refresh, "fresh-main-refresh-token");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("generation falls back from dead auto-selected OpenClaw auth to fresh Codex auth", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-imagen-auth-fallback-"));
  const stateDir = path.join(tempDir, "state");
  const codexHome = path.join(tempDir, "codex-home");
  const authPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  const outDir = path.join(tempDir, "out");
  const expiredAccess = jwtWithExpiry(Date.now() - 20 * 24 * 60 * 60_000);
  const freshCodexAccess = jwtWithExpiry(Date.now() + 60 * 60_000);
  await writeOpenClawAuthProfile(authPath, {
    type: "oauth",
    provider: "openai-codex",
    access: expiredAccess,
    refresh: "already-used-openclaw-refresh-token",
    expires: Date.now() - 20 * 24 * 60 * 60_000,
    accountId: "acct_test",
  });
  await writeCodexAuthJson(codexHome, {
    access: freshCodexAccess,
    refresh: "fresh-codex-refresh-token",
    accountId: "acct_test",
  });

  let refreshRequests = 0;
  let generationRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/oauth/token") {
      refreshRequests += 1;
      reusedRefreshTokenResponse(response);
      return;
    }
    if (request.url === "/backend-api/codex/responses") {
      generationRequests += 1;
      writeImageGenerationResponse(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await runCli(
      [
        "--refresh-url",
        `http://127.0.0.1:${port}/oauth/token`,
        "--base-url",
        `http://127.0.0.1:${port}/backend-api/codex`,
        "--out-dir",
        outDir,
        "--json",
        "--quiet",
        "--prompt",
        "generate one test image",
      ],
      {
        CODEX_HOME: codexHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_AGENT_DIR: "",
        PI_CODING_AGENT_DIR: "",
        CODEX_IMAGEN_AUTH_JSON: "",
        OPENCLAW_CODEX_AUTH_JSON: "",
        CODEX_AUTH_JSON: "",
      }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(refreshRequests, 1);
    assert.equal(generationRequests, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image_count, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("generation falls back when active OpenClaw profile lacks accountId", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-imagen-active-missing-account-"));
  const stateDir = path.join(tempDir, "state");
  const codexHome = path.join(tempDir, "codex-home");
  const authPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  const outDir = path.join(tempDir, "out");
  const configuredProfileId = "openai-codex:hxtxmu@gmail.com";
  const freshAccess = jwtWithExpiry(Date.now() + 60 * 60_000);
  await writeOpenClawAuthProfiles(authPath, {
    "openai-codex:default": {
      type: "oauth",
      provider: "openai-codex",
      access: jwtWithExpiry(Date.now() - 20 * 24 * 60 * 60_000),
      refresh: "already-used-openclaw-refresh-token",
      expires: Date.now() - 20 * 24 * 60 * 60_000,
      accountId: "acct_test",
    },
    [configuredProfileId]: {
      type: "oauth",
      provider: "openai-codex",
      access: freshAccess,
      refresh: "fresh-active-refresh-token",
      expires: Date.now() + 60 * 60_000,
      email: "hxtxmu@gmail.com",
    },
  });
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    `${JSON.stringify(
      {
        auth: {
          profiles: {
            [configuredProfileId]: { provider: "openai-codex" },
          },
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeCodexAuthJson(codexHome, {
    access: jwtWithExpiry(Date.now() + 60 * 60_000),
    refresh: "fresh-codex-refresh-token",
    accountId: "acct_test",
  });

  let generationRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/backend-api/codex/responses") {
      generationRequests += 1;
      writeImageGenerationResponse(response);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await runCli(
      [
        "--base-url",
        `http://127.0.0.1:${port}/backend-api/codex`,
        "--out-dir",
        outDir,
        "--json",
        "--quiet",
        "--prompt",
        "generate one test image",
      ],
      {
        CODEX_HOME: codexHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_AGENT_DIR: "",
        PI_CODING_AGENT_DIR: "",
        CODEX_IMAGEN_AUTH_JSON: "",
        OPENCLAW_CODEX_AUTH_JSON: "",
        CODEX_AUTH_JSON: "",
      }
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(generationRequests, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image_count, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
