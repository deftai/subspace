/**
 * Phase 3 done-when: acp-probe CLI over shared client product + stdio fixture.
 *
 * Covers argv parsing, runProbe API, process exit codes, and package dep bounds
 * (client+wire only). Does not own probe implementation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

import {
  parseArgv,
  runProbe,
  HELP_TEXT,
} from "../packages/acp-probe/src/index.ts";
import {
  buildSessionNewParams,
  formatWireError,
} from "../packages/acp-client/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probeBin = path.join(root, "packages/acp-probe/bin/acp-probe.ts");
const agentScript = path.join(
  root,
  "packages/acp-agent/bin/session-echo-agent.ts",
);
const node = process.execPath;
const strip = "--experimental-strip-types";

/**
 * Spawn acp-probe as a real CLI process; optional kill if hung.
 * Returns exit code + captured streams for exit-code contract tests.
 */
function runCli(
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [strip, probeBin, ...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    // Hard ceiling so a wedged agent cannot hang the suite forever
    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("cli test timeout"));
          }, opts.timeoutMs)
        : undefined;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("phase3_acp_probe", () => {
  it("parseArgv — requires command + prompt; rejects approve-all", () => {
    // approve-all is a hard non-goal; missing command must error with help surface
    const bad = parseArgv([]);
    assert.ok("error" in bad);

    const ok = parseArgv([
      "--command",
      "node",
      "--arg",
      "x.ts",
      "--prompt",
      "hi",
      "--permission",
      "approve-reads",
    ]);
    assert.ok(!("error" in ok));
    if (!("error" in ok)) {
      assert.equal(ok.command, "node");
      assert.deepEqual(ok.args, ["x.ts"]);
      assert.equal(ok.prompt, "hi");
      assert.equal(ok.permissionPolicy, "approve-reads");
    }

    const badPerm = parseArgv([
      "-c",
      "node",
      "-p",
      "x",
      "--permission",
      "approve-all",
    ]);
    assert.ok("error" in badPerm);
    assert.ok(HELP_TEXT.includes("acp-probe"));
  });

  it("runProbe API — stdio session-echo one-shot green", async () => {
    // Library path (no CLI) must still yield dual ids + stream events
    const result = await runProbe({
      command: node,
      args: [strip, agentScript],
      prompt: "probe-hello",
      permissionPolicy: "deny",
      timeoutMs: 15_000,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.acpSessionId);
      assert.ok(result.localId);
      assert.notEqual(result.localId, result.acpSessionId);
      assert.ok(result.events.some((e) => e.type === "update"));
      assert.ok(result.events.some((e) => e.type === "prompt_done"));
      const text = JSON.stringify(result.events);
      assert.ok(text.includes("probe-hello"));
    }
  });

  it("runProbe API — bad command fails (not silent success)", async () => {
    // Failure must set ok:false with a non-empty error string
    const result = await runProbe({
      command: path.join(root, "definitely-not-a-real-agent-binary"),
      args: [],
      prompt: "x",
      timeoutMs: 5_000,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.length > 0);
    }
  });

  it("CLI — smoke vs session-echo-agent exit 0 + transcript", async () => {
    // End-to-end process contract: 0 + acp-probe: ok on stderr
    const { code, stdout, stderr } = await runCli(
      [
        "--command",
        node,
        "--arg",
        strip,
        "--arg",
        agentScript,
        "--prompt",
        "cli-smoke",
        "--permission",
        "approve-reads",
      ],
      { timeoutMs: 20_000 },
    );
    assert.equal(code, 0, `stderr=${stderr}`);
    assert.ok(stdout.includes("prompt_done") || stdout.includes("update"));
    assert.ok(stdout.includes("cli-smoke") || stderr.includes("ok session="));
    assert.ok(stderr.includes("acp-probe: ok"));
  });

  it("CLI — bad flags exit 1", async () => {
    // User error (missing --command) is exit 1, not agent failure
    const { code, stderr } = await runCli(["--prompt", "only"], {
      timeoutMs: 5_000,
    });
    assert.equal(code, 1);
    assert.ok(stderr.includes("acp-probe:"));
  });

  it("CLI — agent failure exit 2", async () => {
    // Spawn/runtime failure is exit 2 so scripts can distinguish from bad flags
    const { code, stderr } = await runCli(
      [
        "--command",
        path.join(root, "no-such-agent-xyz"),
        "--prompt",
        "x",
        "--timeout",
        "3000",
      ],
      { timeoutMs: 10_000 },
    );
    assert.equal(code, 2, `stderr=${stderr}`);
    assert.ok(stderr.includes("fail"));
  });

  it("probe depends on client+wire only (no agent package dep)", () => {
    // Boundary gate: probe must not pull agent or foundation packages
    const require = createRequire(
      path.join(root, "packages/acp-probe/package.json"),
    );
    // resolve package.json of acp-probe
    const pkg = require("./package.json") as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    assert.deepEqual(deps.sort(), [
      "@deft/acp-client",
      "@deft/acp-wire",
    ]);
    assert.ok(!deps.includes("@deft/acp-agent"));
    assert.ok(!deps.includes("@deft/subspace-foundation"));
  });

  it("buildSessionNewParams always includes cwd + mcpServers", () => {
    // Session/new shape must satisfy wire schema even with empty options
    const def = buildSessionNewParams();
    assert.equal(typeof def.cwd, "string");
    assert.ok(def.cwd.length > 0);
    assert.deepEqual(def.mcpServers, []);

    const custom = buildSessionNewParams({
      cwd: "/tmp/smoke",
      mcpServers: [{ name: "x" }],
    });
    assert.equal(custom.cwd, "/tmp/smoke");
    assert.deepEqual(custom.mcpServers, [{ name: "x" }]);
  });

  it("formatWireError never returns [object Object] for RPC errors", () => {
    // Nested data must stringify usefully for probe/user diagnostics
    const s = formatWireError({
      code: -32602,
      message: "Invalid params",
      data: { cwd: { _errors: ["required"] } },
    });
    assert.ok(s.includes("Invalid params"));
    assert.ok(s.includes("32602"));
    assert.ok(!s.includes("[object Object]"));
    assert.equal(formatWireError(new Error("boom")), "boom");
  });
});
