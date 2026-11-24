import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { detectDrift } from "../src/detector.ts";
import { fetchHtml } from "../src/cli.ts";
import type { DriftSchema } from "../src/types.ts";

const FIXTURES_DIR = resolve(import.meta.dir, "../fixtures");
const noSnap = { saveSnapshotOnDrift: false } as const;

async function fixture(name: string): Promise<string> {
  return Bun.file(`${FIXTURES_DIR}/${name}`).text();
}

describe("JSON-LD with multiple blocks", () => {
  test("passes when the matching Product block is not the first ld+json script", async () => {
    const schema: DriftSchema = await Bun.file(`${FIXTURES_DIR}/jsonld-schema.json`).json();
    const report = await detectDrift(await fixture("product-jsonld-multi.html"), schema, noSnap);
    expect(report.errors).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.json?.passed).toBe(true);
  });

  test("passes when the Product lives inside an @graph array", async () => {
    const schema: DriftSchema = await Bun.file(`${FIXTURES_DIR}/jsonld-schema.json`).json();
    const report = await detectDrift(await fixture("product-jsonld-graph.html"), schema, noSnap);
    expect(report.passed).toBe(true);
  });

  test("still fails when no ld+json block satisfies the schema", async () => {
    const schema: DriftSchema = await Bun.file(`${FIXTURES_DIR}/jsonld-schema.json`).json();
    const report = await detectDrift(await fixture("product-jsonld-drifted.html"), schema, noSnap);
    expect(report.passed).toBe(false);
    expect(report.criticalFailure).toBe(true);
    expect(report.json?.missingKeys).toContain("offers.price");
  });

  test("a JSON-LD block that parses to null counts as a failed check, not a skipped one", async () => {
    const html = `<script type="application/ld+json">null</script>`;
    const report = await detectDrift(html, { jsonLd: true }, noSnap);
    expect(report.totalChecks).toBe(1);
    expect(report.passedChecks + report.failedChecks).toBe(1);
    expect(report.passed).toBe(false);
  });
});

describe("Invalid schema entries do not crash detection", () => {
  test("invalid regex pattern is reported as a critical field failure", async () => {
    const schema: DriftSchema = {
      selectors: {
        title: { selector: "h1", required: true },
        price: { selector: ".price", required: true, pattern: "^\\$[0-9+" },
      },
    };
    const html = `<h1>Hi</h1><span class="price">$10</span>`;
    const report = await detectDrift(html, schema, noSnap);
    expect(report.passed).toBe(false);
    expect(report.fields.title?.passed).toBe(true);
    expect(report.fields.price?.passed).toBe(false);
    expect(report.fields.price?.reason).toMatch(/invalid pattern/i);
  });

  test("invalid CSS selector is reported as a critical field failure", async () => {
    const schema: DriftSchema = {
      selectors: {
        title: { selector: "h1", required: true },
        broken: { selector: "div[[", required: true },
      },
    };
    const report = await detectDrift(`<h1>Hi</h1>`, schema, noSnap);
    expect(report.passed).toBe(false);
    expect(report.fields.title?.passed).toBe(true);
    expect(report.fields.broken?.passed).toBe(false);
    expect(report.fields.broken?.reason).toMatch(/invalid selector/i);
  });

  test("invalid item container/field selectors are reported, not thrown", async () => {
    const containerReport = await detectDrift(
      `<ul><li>a</li></ul>`,
      { items: { container: "li[[", minCount: 1 } },
      noSnap
    );
    expect(containerReport.passed).toBe(false);
    expect(containerReport.items?.reason).toMatch(/invalid selector/i);

    const fieldReport = await detectDrift(
      `<ul><li><b>a</b></li></ul>`,
      { items: { container: "li", minCount: 1, fields: { name: { selector: "b[[", required: true } } } },
      noSnap
    );
    expect(fieldReport.passed).toBe(false);
    expect(fieldReport.items?.itemFieldStats?.name?.reason).toMatch(/invalid selector/i);
  });
});

describe("URL fetching", () => {
  test("times out instead of hanging forever on an unresponsive server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {}); // never responds
      },
    });
    try {
      const started = Date.now();
      await expect(fetchHtml(`http://127.0.0.1:${server.port}/`, { timeoutMs: 200 })).rejects.toThrow(
        /timed out/i
      );
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      server.stop(true);
    }
  });

  test("returns the body for a normal response", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("<h1>ok</h1>") });
    try {
      expect(await fetchHtml(`http://127.0.0.1:${server.port}/`, { timeoutMs: 2000 })).toBe("<h1>ok</h1>");
    } finally {
      server.stop(true);
    }
  });
});
