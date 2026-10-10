#!/usr/bin/env bun
import { resolve } from "node:path";
import { detectDrift } from "./detector.ts";
import type { DriftSchema, DriftReport } from "./types.ts";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Envelope<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: T | null; error: string };

interface ParsedCliArgs {
  schemaPath?: string;
  htmlPath?: string;
  url?: string;
  useStdin?: boolean;
  snapshotDir?: string;
  noSnapshot?: boolean;
  maxDrift?: number;
  json?: boolean;
  verbose?: boolean;
  help?: boolean;
  version?: boolean;
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "no-snapshot",
  "verbose",
  "help",
  "h",
  "version",
  "v",
  "stdin",
]);

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {};
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i++;
      continue;
    }

    if (arg === "--") {
      break;
    }

    if (arg === "-h" || arg === "--help") {
      result.help = true;
      i++;
      continue;
    }

    if (arg === "-v" || arg === "--version") {
      result.version = true;
      i++;
      continue;
    }

    if (arg === "--json") {
      result.json = true;
      i++;
      continue;
    }

    if (arg === "--no-snapshot") {
      result.noSnapshot = true;
      i++;
      continue;
    }

    if (arg === "--verbose") {
      result.verbose = true;
      i++;
      continue;
    }

    if (arg === "--stdin") {
      result.useStdin = true;
      i++;
      continue;
    }

    if (arg === "-s" || arg === "--schema") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new UsageError(`Flag '${arg}' requires a file path value`);
      }
      result.schemaPath = val;
      i++;
      continue;
    }

    if (arg.startsWith("--schema=")) {
      result.schemaPath = arg.slice("--schema=".length);
      i++;
      continue;
    }

    if (arg === "-i" || arg === "--html") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new UsageError(`Flag '${arg}' requires an HTML file path`);
      }
      result.htmlPath = val;
      i++;
      continue;
    }

    if (arg.startsWith("--html=")) {
      result.htmlPath = arg.slice("--html=".length);
      i++;
      continue;
    }

    if (arg === "-u" || arg === "--url") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new UsageError(`Flag '${arg}' requires a URL value`);
      }
      result.url = val;
      i++;
      continue;
    }

    if (arg.startsWith("--url=")) {
      result.url = arg.slice("--url=".length);
      i++;
      continue;
    }

    if (arg === "--snapshot-dir") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) {
        throw new UsageError("Flag '--snapshot-dir' requires a directory path");
      }
      result.snapshotDir = val;
      i++;
      continue;
    }

    if (arg.startsWith("--snapshot-dir=")) {
      result.snapshotDir = arg.slice("--snapshot-dir=".length);
      i++;
      continue;
    }

    if (arg === "--max-drift") {
      const val = argv[++i];
      if (!val || isNaN(Number(val))) {
        throw new UsageError("Flag '--max-drift' requires a numeric percentage (0-100)");
      }
      result.maxDrift = Number(val);
      i++;
      continue;
    }

    if (arg.startsWith("--max-drift=")) {
      const val = arg.slice("--max-drift=".length);
      if (isNaN(Number(val))) {
        throw new UsageError("Flag '--max-drift' requires a numeric percentage (0-100)");
      }
      result.maxDrift = Number(val);
      i++;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new UsageError(`Unknown flag '${arg}'. Run with --help for usage.`);
    }

    // Positional argument fallback: first positional can be schema, second html
    if (!result.schemaPath) {
      result.schemaPath = arg;
    } else if (!result.htmlPath) {
      result.htmlPath = arg;
    } else {
      throw new UsageError(`Unexpected argument '${arg}'`);
    }
    i++;
  }

  return result;
}

function showHelp(): void {
  console.log(`scraper-drift-detector v0.1.0
Fast DOM & schema drift detector for web scraping pipelines.
Exits 1 on critical drift to stop silent empty-scrape data corruption.

USAGE:
  scraper-drift-detector --schema <file> [--html <file> | --url <url>] [options]
  curl -s <url> | scraper-drift-detector --schema <file> [options]

REQUIRED:
  -s, --schema <path>         Path to drift schema JSON file

INPUT SOURCE (one of):
  -i, --html <path>           Path to local HTML file to evaluate
  -u, --url <url>             URL to fetch and evaluate directly
  --stdin                     Read HTML from standard input (default when piped)

OPTIONS:
  --max-drift <percent>       Allowed drift threshold (0-100, default: 0)
  --snapshot-dir <path>       Directory to store HTML snapshots on drift (default: .snapshots)
  --no-snapshot               Disable snapshotting on drift
  --json                      Emit structured JSON envelope for machine processing
  --verbose                   Show detailed breakdown of all evaluated elements
  -v, --version               Show version
  -h, --help                  Show this help text

EXIT CODES:
  0   Passed (no critical drift; drift <= allowed threshold)
  1   Drift detected (missing required fields, item count below min, or drift > threshold)
  2   Usage error (bad args, missing schema, unreadable file)
`);
}

function formatReportHuman(report: DriftReport, verbose = false): string {
  const lines: string[] = [];
  lines.push("------------------------------------------------------------");
  lines.push(`SCRAPER DRIFT REPORT: ${report.schemaName || "Target Evaluation"}`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push("------------------------------------------------------------");

  // Selectors
  if (Object.keys(report.fields).length > 0) {
    lines.push("Fields:");
    for (const [name, res] of Object.entries(report.fields)) {
      const tag = res.passed ? "[PASS]" : res.criticalFailure ? "[FAIL-CRITICAL]" : "[FAIL-DRIFT]";
      const reqMarker = res.required ? " (REQUIRED)" : "";
      const valStr = res.sampleValue ? ` -> "${res.sampleValue.slice(0, 40)}${res.sampleValue.length > 40 ? "..." : ""}"` : "";
      lines.push(`  ${tag.padEnd(16)} ${name}${reqMarker}`);
      lines.push(`                   selector: ${res.selector} | count: ${res.count}${valStr}`);
      if (!res.passed && res.reason) {
        lines.push(`                   issue: ${res.reason}`);
      }
    }
  }

  // Items
  if (report.items) {
    lines.push("");
    lines.push("Item Collection:");
    const itemTag = report.items.passed ? "[PASS]" : "[FAIL-CRITICAL]";
    lines.push(`  ${itemTag.padEnd(16)} Container: ${report.items.container}`);
    lines.push(`                   Found ${report.items.count} items (min required: ${report.items.minCount})`);
    if (report.items.reason) {
      lines.push(`                   issue: ${report.items.reason}`);
    }

    if (report.items.itemFieldStats) {
      lines.push("  Item Fields:");
      for (const [subName, stat] of Object.entries(report.items.itemFieldStats)) {
        const subTag = stat.passed ? "[PASS]" : stat.required ? "[FAIL-CRITICAL]" : "[FAIL-DRIFT]";
        lines.push(`    ${subTag.padEnd(14)} ${subName}: ${stat.presentCount}/${stat.totalItems} items (${stat.passRatePercent}%)`);
      }
    }
  }

  // JSON
  if (report.json) {
    lines.push("");
    lines.push("JSON / JSON-LD Data:");
    const jsonTag = report.json.passed ? "[PASS]" : "[FAIL-CRITICAL]";
    lines.push(`  ${jsonTag.padEnd(16)} Payload validation`);
    if (report.json.missingKeys.length > 0) {
      lines.push(`                   missing keys: ${report.json.missingKeys.join(", ")}`);
    }
    for (const check of report.json.arrayLengthChecks) {
      lines.push(`                   path '${check.path}': found ${check.foundCount}, min ${check.minCount}`);
    }
  }

  lines.push("------------------------------------------------------------");
  lines.push(`Summary:`);
  lines.push(`  Total Checks:    ${report.totalChecks}`);
  lines.push(`  Passed Checks:   ${report.passedChecks}`);
  lines.push(`  Failed Checks:   ${report.failedChecks}`);
  lines.push(`  Drift Rate:      ${report.driftPercent.toFixed(2)}%`);
  lines.push(`  Critical Drift:  ${report.criticalFailure ? "YES (FAIL)" : "NO"}`);
  lines.push(`  Overall Status:  ${report.passed ? "PASS" : "FAIL"}`);

  if (report.snapshotPath) {
    lines.push(`  Snapshot Saved:  ${report.snapshotPath}`);
  }
  lines.push("------------------------------------------------------------");

  if (!report.passed) {
    lines.push("[EXIT 1] Scraper drift detected. Halting pipeline to prevent empty scrape data corruption.");
  }

  return lines.join("\n");
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let isJsonMode = false;
  try {
    const args = parseCliArgs(argv);
    isJsonMode = Boolean(args.json);

    if (args.help) {
      showHelp();
      return 0;
    }

    if (args.version) {
      console.log("scraper-drift-detector v0.1.0");
      return 0;
    }

    if (!args.schemaPath) {
      throw new UsageError("Missing required '--schema <path>' argument. Run with --help for usage.");
    }

    // Load schema
    const schemaFile = Bun.file(resolve(process.cwd(), args.schemaPath));
    if (!(await schemaFile.exists())) {
      throw new UsageError(`Schema file not found at: ${args.schemaPath}`);
    }

    let schema: DriftSchema;
    try {
      schema = (await schemaFile.json()) as DriftSchema;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new UsageError(`Failed to parse schema JSON: ${msg}`);
    }

    // Determine HTML input source
    let htmlContent = "";
    if (args.htmlPath) {
      const htmlFile = Bun.file(resolve(process.cwd(), args.htmlPath));
      if (!(await htmlFile.exists())) {
        throw new UsageError(`HTML file not found at: ${args.htmlPath}`);
      }
      htmlContent = await htmlFile.text();
    } else if (args.url) {
      try {
        const resp = await fetch(args.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (ScraperDriftDetector/0.1.0; +https://github.com/nadimtuhin/scraper-drift-detector)",
          },
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }
        htmlContent = await resp.text();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to fetch URL '${args.url}': ${msg}`);
      }
    } else {
      // Check stdin
      // If terminal is not interactive or stdin flag provided
      const isPipe = !process.stdin.isTTY;
      if (args.useStdin || isPipe) {
        htmlContent = await new Response(Bun.stdin.stream()).text();
      } else {
        throw new UsageError("No input specified. Provide --html <file>, --url <url>, or pipe HTML via stdin.");
      }
    }

    // Run drift detection
    const report = await detectDrift(htmlContent, schema, {
      snapshotDir: args.snapshotDir,
      saveSnapshotOnDrift: !args.noSnapshot,
      maxAllowedDriftPercent: args.maxDrift,
    });

    if (isJsonMode) {
      if (report.passed) {
        const envelope: Envelope<DriftReport> = {
          ok: true,
          data: report,
          error: null,
        };
        console.log(JSON.stringify(envelope, null, 2));
      } else {
        const envelope: Envelope<DriftReport> = {
          ok: false,
          data: report,
          error: report.criticalFailure
            ? `Critical drift detected (${report.failedChecks} check(s) failed)`
            : `Drift percentage ${report.driftPercent}% exceeded threshold`,
        };
        console.log(JSON.stringify(envelope, null, 2));
      }
    } else {
      console.log(formatReportHuman(report, args.verbose));
    }

    return report.passed ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) {
      if (isJsonMode) {
        const envelope: Envelope<null> = {
          ok: false,
          data: null,
          error: err.message,
        };
        console.log(JSON.stringify(envelope, null, 2));
      } else {
        console.error(`Usage Error: ${err.message}`);
      }
      return 2;
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (isJsonMode) {
      const envelope: Envelope<null> = {
        ok: false,
        data: null,
        error: msg,
      };
      console.log(JSON.stringify(envelope, null, 2));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }
}

// Auto-run if executed directly
if (import.meta.main) {
  const code = await runCli();
  process.exit(code);
}
