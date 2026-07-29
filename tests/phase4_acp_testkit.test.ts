/**
 * Phase 4 done-when: @deft/acp-testkit importable scenarios on client product.
 *
 * Gates: ≥3 scenarios linked; ≥1 stdio; no second client; no acp-tester package.
 *
 * Path matrix (Elon 2026-07-29): all three named scenarios on linked; ≥1 stdio
 * (prefer multi-turn). Full 3×2 matrix is out.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  scenarioMultiTurnLinked,
  scenarioMultiTurnStdio,
  scenarioCancelMidPromptLinked,
  scenarioCancelMidPromptStdio,
  scenarioPermissionReverseLinked,
  runMinimumScenarios,
  withLinkedProduct,
  collectEvents,
  assertPromptDone,
  runMultiTurn,
  runCancelMidPrompt,
  runPermissionReverse,
} from "../packages/acp-testkit/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("phase4_acp_testkit", () => {
  it("package exists as @deft/acp-testkit (no acp-tester)", () => {
    // Structural non-goals: package name, deps, and no acp-tester twin
    const pkgPath = path.join(root, "packages/acp-testkit/package.json");
    assert.equal(existsSync(pkgPath), true, "packages/acp-testkit must exist");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
    };
    assert.equal(pkg.name, "@deft/acp-testkit");
    // Product path: client + wire; agent only as fixture peer for harness
    assert.ok(pkg.dependencies?.["@deft/acp-client"]);
    assert.ok(pkg.dependencies?.["@deft/acp-wire"]);
    // Explicit non-goal: no acp-tester package
    assert.equal(
      existsSync(path.join(root, "packages/acp-tester")),
      false,
      "acp-tester must not exist",
    );
    // Public API surface is importable (this module already did)
    assert.equal(typeof runMultiTurn, "function");
    assert.equal(typeof runCancelMidPrompt, "function");
    assert.equal(typeof runPermissionReverse, "function");
  });

  it("linked — multi-turn scenario", async () => {
    const r = await scenarioMultiTurnLinked();
    assert.equal(r.ok, true);
    assert.equal(r.mode, "linked");
    assert.equal(r.name, "multi-turn");
  });

  it("linked — cancel mid-prompt scenario", async () => {
    const r = await scenarioCancelMidPromptLinked();
    assert.equal(r.ok, true);
    assert.equal(r.name, "cancel-mid-prompt");
  });

  it("linked — permission reverse deny + approve-reads", async () => {
    const r = await scenarioPermissionReverseLinked();
    assert.equal(r.ok, true);
    assert.equal(r.name, "permission-reverse");
  });

  it("stdio — multi-turn scenario (required path)", async () => {
    // Matrix minimum: at least one full stdio scenario must stay green
    const r = await scenarioMultiTurnStdio();
    assert.equal(r.ok, true);
    assert.equal(r.mode, "stdio");
  });

  it("stdio — cancel mid-prompt survives", async () => {
    const r = await scenarioCancelMidPromptStdio();
    assert.equal(r.ok, true);
    assert.equal(r.mode, "stdio");
  });

  it("assert helpers work on live product stream", async () => {
    // Helpers are not scenario-only — usable on ad-hoc product streams
    const h = await withLinkedProduct({ permissionPolicy: "deny" });
    try {
      const s = await h.product.sessions.create();
      const events = await collectEvents(s.prompt("kit-assert"));
      assertPromptDone(events);
    } finally {
      await h.dispose();
    }
  });

  it("runMinimumScenarios — all green", async () => {
    // Aggregate entry: kit's declared minimum set must all pass
    const results = await runMinimumScenarios();
    assert.ok(results.length >= 4);
    assert.ok(results.every((r) => r.ok));
    assert.ok(results.some((r) => r.mode === "stdio"));
    assert.ok(results.some((r) => r.name === "multi-turn"));
    assert.ok(results.some((r) => r.name === "cancel-mid-prompt"));
    assert.ok(results.some((r) => r.name === "permission-reverse"));
  });
});
