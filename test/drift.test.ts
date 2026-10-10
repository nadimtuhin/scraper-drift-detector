import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { detectDrift, detectJsonDrift } from "../src/detector.ts";
import type { DriftSchema } from "../src/types.ts";

const FIXTURES_DIR = resolve(import.meta.dir, "../fixtures");
const SNAPSHOT_TEST_DIR = resolve(import.meta.dir, "../.test-snapshots");
const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");

async function runCli(args: string[], stdinInput?: string) {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdinInput ? "pipe" : "ignore",
    env: { ...process.env },
  });

  if (stdinInput && proc.stdin) {
    proc.stdin.write(stdinInput);
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("Drift Detection Engine", () => {
  let ecommerceSchema: DriftSchema;
  let listingSchema: DriftSchema;
  let jsonSchema: DriftSchema;

  let validEcommerceHtml: string;
  let driftedEcommerceHtml: string;
  let criticalEcommerceHtml: string;

  let validListingHtml: string;
  let emptyListingHtml: string;

  let validPayloadJson: unknown;
  let driftedPayloadJson: unknown;

  beforeAll(async () => {
    ecommerceSchema = await Bun.file(`${FIXTURES_DIR}/ecommerce-schema.json`).json();
    listingSchema = await Bun.file(`${FIXTURES_DIR}/listing-schema.json`).json();
    jsonSchema = await Bun.file(`${FIXTURES_DIR}/json-schema.json`).json();

    validEcommerceHtml = await Bun.file(`${FIXTURES_DIR}/ecommerce-valid.html`).text();
    driftedEcommerceHtml = await Bun.file(`${FIXTURES_DIR}/ecommerce-drifted.html`).text();
    criticalEcommerceHtml = await Bun.file(`${FIXTURES_DIR}/ecommerce-critical.html`).text();

    validListingHtml = await Bun.file(`${FIXTURES_DIR}/listing-valid.html`).text();
    emptyListingHtml = await Bun.file(`${FIXTURES_DIR}/listing-empty.html`).text();

    validPayloadJson = await Bun.file(`${FIXTURES_DIR}/payload-valid.json`).json();
    driftedPayloadJson = await Bun.file(`${FIXTURES_DIR}/payload-drifted.json`).json();
  });

  afterAll(async () => {
    await rm(SNAPSHOT_TEST_DIR, { recursive: true, force: true });
  });

  test("passes valid HTML with 0% drift", async () => {
    const report = await detectDrift(validEcommerceHtml, ecommerceSchema, {
      snapshotDir: SNAPSHOT_TEST_DIR,
    });

    expect(report.passed).toBe(true);
    expect(report.criticalFailure).toBe(false);
    expect(report.driftPercent).toBe(0);
    expect(report.failedChecks).toBe(0);
    expect(report.passedChecks).toBe(5);
    expect(report.snapshotPath).toBeUndefined();
    expect(report.fields.title?.sampleValue).toBe("Premium Noise-Cancelling Headphones");
    expect(report.fields.price?.sampleValue).toBe("$299.99");
    expect(report.fields.sku?.sampleValue).toBe("TECH-NC-9000");
  });

  test("calculates non-critical drift percentage and obeys maxAllowedDriftPercent", async () => {
    // 1 of 5 checks failed (availability badge selector changed)
    const strictReport = await detectDrift(driftedEcommerceHtml, ecommerceSchema, {
      snapshotDir: SNAPSHOT_TEST_DIR,
      maxAllowedDriftPercent: 0,
    });

    expect(strictReport.passed).toBe(false);
    expect(strictReport.criticalFailure).toBe(false);
    expect(strictReport.driftPercent).toBe(20);
    expect(strictReport.failedChecks).toBe(1);
    expect(strictReport.snapshotPath).toBeDefined();

    // Tolerant evaluation (allow up to 25% drift)
    const tolerantReport = await detectDrift(driftedEcommerceHtml, ecommerceSchema, {
      snapshotDir: SNAPSHOT_TEST_DIR,
      maxAllowedDriftPercent: 25,
      saveSnapshotOnDrift: false,
    });

    expect(tolerantReport.passed).toBe(true);
    expect(tolerantReport.criticalFailure).toBe(false);
    expect(tolerantReport.driftPercent).toBe(20);
  });

  test("flags critical failure when required field has empty text or missing selector", async () => {
    const report = await detectDrift(criticalEcommerceHtml, ecommerceSchema, {
      snapshotDir: SNAPSHOT_TEST_DIR,
    });

    expect(report.passed).toBe(false);
    expect(report.criticalFailure).toBe(true);
    expect(report.fields.price?.criticalFailure).toBe(true);
    expect(report.fields.buyButton?.criticalFailure).toBe(true);
    expect(report.snapshotPath).toBeDefined();

    // Verify snapshot file was created
    if (report.snapshotPath) {
      const snapFile = Bun.file(report.snapshotPath);
      expect(await snapFile.exists()).toBe(true);
      const content = await snapFile.text();
      expect(content).toContain("product-redesign-v2");
    }
  });

  test("validates item listings and catches empty scrape silent failure", async () => {
    // Valid listing with 4 cards (min 3)
    const validReport = await detectDrift(validListingHtml, listingSchema, {
      snapshotDir: SNAPSHOT_TEST_DIR,
    });

    expect(validReport.passed).toBe(true);
    expect(validReport.criticalFailure).toBe(false);
    expect(validReport.items?.count).toBe(4);
    expect(validReport.items?.itemFieldStats?.title?.presentCount).toBe(4);

    // Empty listing (0 cards found, expected min 3) -> critical failure!
    const emptyReport = await detectDrift(emptyListingHtml, listingSchema, {
      snapshotDir: SNAPSHOT_TEST_DIR,
    });

    expect(emptyReport.passed).toBe(false);
    expect(emptyReport.criticalFailure).toBe(true);
    expect(emptyReport.items?.passed).toBe(false);
    expect(emptyReport.items?.count).toBe(0);
    expect(emptyReport.snapshotPath).toBeDefined();
  });

  test("evaluates JSON payload schema drift and min items", () => {
    const validResult = detectJsonDrift(validPayloadJson, jsonSchema);
    expect(validResult.passed).toBe(true);
    expect(validResult.criticalFailure).toBe(false);

    const driftedResult = detectJsonDrift(driftedPayloadJson, jsonSchema);
    expect(driftedResult.passed).toBe(false);
    expect(driftedResult.criticalFailure).toBe(true);
    expect(driftedResult.reason).toContain("data.items");
  });

  test("handles empty and malformed HTML gracefully without crashing", async () => {
    const emptyReport = await detectDrift("", ecommerceSchema, {
      snapshotDir: SNAPSHOT_TEST_DIR,
      saveSnapshotOnDrift: false,
    });
    expect(emptyReport.passed).toBe(false);
    expect(emptyReport.criticalFailure).toBe(true);
    expect(emptyReport.driftPercent).toBe(100);

    const malformedReport = await detectDrift(
      "<div><h1 class='product-title'>Unclosed Title",
      ecommerceSchema,
      { snapshotDir: SNAPSHOT_TEST_DIR, saveSnapshotOnDrift: false }
    );
    expect(malformedReport.fields.title?.passed).toBe(true);
    expect(malformedReport.fields.title?.sampleValue).toBe("Unclosed Title");
  });

  test("validates pattern matching regex correctly", async () => {
    const invalidPriceHtml = validEcommerceHtml.replace("$299.99", "Free Sample");
    const report = await detectDrift(invalidPriceHtml, ecommerceSchema, {
      snapshotDir: SNAPSHOT_TEST_DIR,
      saveSnapshotOnDrift: false,
    });

    expect(report.passed).toBe(false);
    expect(report.criticalFailure).toBe(true);
    expect(report.fields.price?.passed).toBe(false);
    expect(report.fields.price?.patternMatched).toBe(false);
  });
});

describe("CLI Integration & Process Exit Codes", () => {
  test("--help prints usage and exits with code 0", async () => {
    const res = await runCli(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("scraper-drift-detector");
    expect(res.stdout).toContain("USAGE:");
  });

  test("--version prints version and exits with code 0", async () => {
    const res = await runCli(["--version"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("0.1.0");
  });

  test("exits with code 2 on usage error (missing schema)", async () => {
    const res = await runCli([]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Usage Error");
  });

  test("exits with code 2 on non-existent schema file", async () => {
    const res = await runCli(["--schema", "does-not-exist.json", "--html", `${FIXTURES_DIR}/ecommerce-valid.html`]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Schema file not found");
  });

  test("exits with code 0 on valid HTML scrape target", async () => {
    const res = await runCli([
      "--schema", `${FIXTURES_DIR}/ecommerce-schema.json`,
      "--html", `${FIXTURES_DIR}/ecommerce-valid.html`,
      "--no-snapshot",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Overall Status:  PASS");
    expect(res.stdout).toContain("Critical Drift:  NO");
  });

  test("exits with code 1 on critical drift in HTML target", async () => {
    const res = await runCli([
      "--schema", `${FIXTURES_DIR}/ecommerce-schema.json`,
      "--html", `${FIXTURES_DIR}/ecommerce-critical.html`,
      "--snapshot-dir", SNAPSHOT_TEST_DIR,
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Overall Status:  FAIL");
    expect(res.stdout).toContain("Critical Drift:  YES (FAIL)");
    expect(res.stdout).toContain("[EXIT 1]");
  });

  test("exits with code 1 on empty listing scrape target", async () => {
    const res = await runCli([
      "--schema", `${FIXTURES_DIR}/listing-schema.json`,
      "--html", `${FIXTURES_DIR}/listing-empty.html`,
      "--snapshot-dir", SNAPSHOT_TEST_DIR,
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("FAIL-CRITICAL");
  });

  test("reads HTML from stdin via pipe and evaluates accurately", async () => {
    const html = await Bun.file(`${FIXTURES_DIR}/ecommerce-valid.html`).text();
    const res = await runCli(
      ["--schema", `${FIXTURES_DIR}/ecommerce-schema.json`, "--no-snapshot"],
      html
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Overall Status:  PASS");
  });

  test("emits JSON envelope on success (--json flag)", async () => {
    const res = await runCli([
      "--schema", `${FIXTURES_DIR}/ecommerce-schema.json`,
      "--html", `${FIXTURES_DIR}/ecommerce-valid.html`,
      "--json",
    ]);

    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.passed).toBe(true);
    expect(parsed.data.criticalFailure).toBe(false);
    expect(parsed.error).toBeNull();
  });

  test("emits JSON envelope on critical drift (--json flag)", async () => {
    const res = await runCli([
      "--schema", `${FIXTURES_DIR}/ecommerce-schema.json`,
      "--html", `${FIXTURES_DIR}/ecommerce-critical.html`,
      "--json",
      "--no-snapshot",
    ]);

    expect(res.exitCode).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.data.passed).toBe(false);
    expect(parsed.data.criticalFailure).toBe(true);
    expect(parsed.error).toContain("Critical drift detected");
  });

  test("emits JSON envelope on usage error (--json flag)", async () => {
    const res = await runCli(["--schema", "missing.json", "--json"]);
    expect(res.exitCode).toBe(2);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toContain("Schema file not found");
  });
});
