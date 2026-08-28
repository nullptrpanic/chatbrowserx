import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

test("keeps the complete E2E subsystem below the root e2e directory", () => {
  for (const legacyPath of [
    "scripts/live-e2e",
    "tests/scripts/live-e2e",
    "tests/e2e",
    "playwright.config.ts",
    "e2e/lib",
    "e2e/scripts",
    "e2e/runner/scenarios.ts",
    ".chatbrowserx-live-e2e",
    "test-results/live-e2e",
    "artifacts/playwright",
    "docs/live-e2e-evaluation.local.md",
    "docs/live-e2e-cases.local.md",
    "docs/superpowers/specs/2026-08-20-live-browser-e2e-design.md",
    "docs/superpowers/plans/2026-08-20-live-browser-e2e.md",
    "docs/superpowers/plans/2026-08-21-lark-calendar-mail-screenshot-live-e2e.md",
    "e2e/DIRECTORY_CONSOLIDATION_DESIGN.md",
    "e2e/IMPLEMENTATION_PLAN.md",
  ]) {
    expect(existsSync(resolve(root, legacyPath)), legacyPath).toBe(false);
  }

  for (const requiredPath of [
    "e2e/AGENTS.md",
    "e2e/RUNBOOK.md",
    "e2e/EVALUATION_STANDARD.md",
    "e2e/SAMPLE_SPEC.md",
    "e2e/playwright.config.ts",
    "e2e/runner",
    "e2e/tests/runner",
    "e2e/tests/browser",
  ]) {
    expect(existsSync(resolve(root, requiredPath)), requiredPath).toBe(true);
  }

  const pkg = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
  };
  for (const name of [
    "e2e:catalog:validate",
    "e2e:env:doctor",
    "e2e:results:compare",
    "e2e:live:setup",
    "e2e:live:verify",
    "e2e:live:run",
    "e2e:live:benchmark",
    "e2e:live:provider-diagnose",
    "e2e:live:seed-product",
  ]) {
    expect(pkg.scripts[name]).toContain("e2e/runner/");
  }
  expect(pkg.scripts["test:e2e"]).toContain("e2e/playwright.config.ts");

  const ignore = readFileSync(resolve(root, ".gitignore"), "utf8");
  expect(ignore).toContain("/e2e/samples/");
  expect(ignore).toContain("/e2e/.runtime/");
});
