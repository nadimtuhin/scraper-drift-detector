# scraper-drift-detector

> Fast DOM and schema drift detector for web scraping targets. Catches selector changes, empty pages, and structural rot before silent 0-exit failures corrupt your dataset.

[![test](https://img.shields.io/badge/tests-bun%20test-green.svg)](https://bun.sh)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## The Problem

Scrapers almost never crash loudly when a target website updates its DOM. Instead, they fail silently:

1. **Silent 0-Exit Corruption**: Target CSS classes change from `.price-current` to `.price__current-val`. The scraper extracts `null` or `""`, writes hundreds of empty records into production databases, and exits with code `0`.
2. **Skeleton & Placeholder Scrapes**: Anti-bot protections or client-side SPAs return placeholder HTML (`<span class="price">   </span>`). Simple element existence checks pass, but the text is blank.
3. **Empty Listing Traps**: A search listing endpoint paginates into an empty page or captcha block. The scraper extracts 0 items, reports success, and marks the scrape run as complete.
4. **Post-Mortem Blindness**: When engineers notice data decay days later, the HTML that broke the scraper is gone, leaving no reproducible snapshot to debug.

`scraper-drift-detector` acts as a zero-overhead pre-flight and runtime circuit breaker:
- Evaluates target DOM and JSON against strict schema definitions.
- Calculates exact drift percentage and marks critical missing fields.
- **Hard-exits with code 1** when required fields or item counts drift.
- Automatically saves timestamped HTML snapshots of failed pages for instant post-mortem analysis.

---

## Quickstart

### 1. Run via Bun

```bash
# Direct run via Bun
bunx scraper-drift-detector --schema schema.json --html page.html

# Or pipe HTML directly from curl / scrapers
curl -s https://example.com/products/123 | bun run src/cli.ts --schema schema.json
```

### 2. Example Schema (`schema.json`)

```json
{
  "name": "Ecommerce Product Page",
  "maxAllowedDriftPercent": 0,
  "selectors": {
    "title": {
      "selector": "h1.product-title",
      "required": true
    },
    "price": {
      "selector": "span.price-current",
      "required": true,
      "pattern": "^\\$[0-9]+(\\.[0-9]{2})?$"
    },
    "sku": {
      "selector": "meta[itemprop='sku']",
      "attribute": "content"
    },
    "buyButton": {
      "selector": "button.btn-add-to-cart",
      "required": true
    }
  }
}
```

### 3. CLI Output

When the page matches:
```
------------------------------------------------------------
SCRAPER DRIFT REPORT: Ecommerce Product Page
------------------------------------------------------------
Fields:
  [PASS]           title (REQUIRED)
                   selector: h1.product-title | count: 1 -> "Premium Headphones"
  [PASS]           price (REQUIRED)
                   selector: span.price-current | count: 1 -> "$299.99"
  [PASS]           sku
                   selector: meta[itemprop='sku'] | count: 1 -> "TECH-9000"
  [PASS]           buyButton (REQUIRED)
                   selector: button.btn-add-to-cart | count: 1 -> "Add to Cart"
------------------------------------------------------------
Summary:
  Total Checks:    4
  Passed Checks:   4
  Failed Checks:   0
  Drift Rate:      0.00%
  Critical Drift:  NO
  Overall Status:  PASS
------------------------------------------------------------
(exit code: 0)
```

When selectors drift:
```
------------------------------------------------------------
SCRAPER DRIFT REPORT: Ecommerce Product Page
------------------------------------------------------------
Fields:
  [PASS]           title (REQUIRED)
                   selector: h1.product-title | count: 1 -> "Premium Headphones"
  [FAIL-CRITICAL]  price (REQUIRED)
                   selector: span.price-current | count: 1
                   issue: Required field 'price' exists but contains empty text/value
  [FAIL-CRITICAL]  buyButton (REQUIRED)
                   selector: button.btn-add-to-cart | count: 0
                   issue: Required selector 'button.btn-add-to-cart' not found in DOM
------------------------------------------------------------
Summary:
  Total Checks:    4
  Passed Checks:   2
  Failed Checks:   2
  Drift Rate:      50.00%
  Critical Drift:  YES (FAIL)
  Overall Status:  FAIL
  Snapshot Saved:  /repo/.snapshots/drift-1760086800-ecommerce.html
------------------------------------------------------------
[EXIT 1] Scraper drift detected. Halting pipeline to prevent empty scrape data corruption.
(exit code: 1)
```

---

## CLI Usage

```
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
  -h, --help                  Show help text
```

### Machine-Readable JSON Mode (`--json`)

Integrate directly into scripts with a stable output envelope:

```bash
bun run src/cli.ts --schema schema.json --html page.html --json
```

```json
{
  "ok": false,
  "data": {
    "schemaName": "Ecommerce Product Page",
    "passed": false,
    "criticalFailure": true,
    "driftPercent": 50.0,
    "totalChecks": 4,
    "passedChecks": 2,
    "failedChecks": 2,
    "fields": { },
    "snapshotPath": "/path/.snapshots/drift-1760086800-ecommerce.html"
  },
  "error": "Critical drift detected (2 check(s) failed)"
}
```

### Exit Codes

| Code | Meaning | Action in Pipeline |
| :--- | :--- | :--- |
| `0` | **Passed**: Drift is within allowed tolerance, no required fields missing | Proceed to database write |
| `1` | **Drift Detected**: Required selector missing/empty or drift exceeded threshold | Abort pipeline, alert engineering |
| `2` | **Usage Error**: Missing CLI argument, unreadable schema file | Fix CLI invocation |

---

## Schema Reference

### 1. Element Selectors (`selectors`)

```json
{
  "selectors": {
    "title": "h1.product-title",
    "price": {
      "selector": "span.price-current",
      "required": true,
      "minCount": 1,
      "pattern": "^\\$[0-9]+(\\.[0-9]{2})?$"
    },
    "canonicalUrl": {
      "selector": "link[rel='canonical']",
      "attribute": "href",
      "required": true
    }
  }
}
```

- **`selector`** *(string, required)*: CSS selector evaluated via Cheerio.
- **`required`** *(boolean, default: false)*: If `true`, a missing element or whitespace-only text is a critical failure.
- **`minCount`** *(number, default: 1)*: Minimum number of matching elements expected.
- **`attribute`** *(string, optional)*: Reads element attribute instead of inner text (e.g. `href`, `src`, `content`).
- **`pattern`** *(string, optional)*: Regex pattern string that extracted text/attribute must match.
- **`allowEmpty`** *(boolean, default: false)*: When `false` and `required: true`, empty/whitespace text triggers critical drift.

### 2. Repeating Item Collections (`items`)

Prevent silent failures when catalog or table pages drop from 20 items to 0:

```json
{
  "items": {
    "container": "article.product-card",
    "minCount": 10,
    "fields": {
      "title": { "selector": "h2.card-title", "required": true },
      "price": { "selector": "span.card-price", "required": true },
      "link": { "selector": "a.card-link", "attribute": "href", "required": true }
    }
  }
}
```

### 3. JSON & API Schemas (`json`)

For scrapers extracting Next.js `__NEXT_DATA__`, `<script type="application/ld+json">`, or REST APIs:

```json
{
  "jsonLd": true,
  "json": {
    "requiredKeys": ["@context", "offers.price", "name"],
    "minItems": {
      "path": "review",
      "minCount": 1
    }
  }
}
```

---

## Library Usage (TypeScript / ESM)

Use `scraper-drift-detector` programmatically inside Puppeteer, Playwright, or Cheerio scrapers:

```typescript
import { detectDrift, type DriftSchema } from "scraper-drift-detector";

const schema: DriftSchema = {
  name: "Amazon Product",
  maxAllowedDriftPercent: 0,
  selectors: {
    title: { selector: "#productTitle", required: true },
    price: { selector: ".a-price .a-offscreen", required: true },
  },
};

const html = await page.content();
const report = await detectDrift(html, schema, {
  snapshotDir: "./snapshots",
  saveSnapshotOnDrift: true,
});

if (!report.passed) {
  console.error(`Scrape aborted: drift is ${report.driftPercent}%`);
  if (report.snapshotPath) {
    console.error(`Debug snapshot saved at: ${report.snapshotPath}`);
  }
  process.exit(1);
}

// Safe to extract and persist
```

---

## CI & Automated Monitoring Integration

Run daily or hourly drift smoke tests with GitHub Actions to detect site layout redesigns before batch jobs fail:

```yaml
name: Scraper Target Drift Watchdog

on:
  schedule:
    - cron: "0 */6 * * *" # Every 6 hours
  workflow_dispatch:

jobs:
  check-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install

      - name: Verify Scraping Targets
        run: |
          bun run src/cli.ts --schema fixtures/ecommerce-schema.json --url "https://example.com/target-page"

      - name: Archive Drift Snapshot on Failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: drift-snapshots
          path: .snapshots/
```

---

## Development & Testing

```bash
# Clone and install
git clone https://github.com/nadimtuhin/scraper-drift-detector.git
cd scraper-drift-detector
bun install

# Run test suite
bun test

# Run CLI directly
bun run src/cli.ts --help
```

---

## License

[MIT](LICENSE) © 2026 Nadim Tuhin
