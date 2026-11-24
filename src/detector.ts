import * as cheerio from "cheerio";
import { saveSnapshot } from "./snapshot.ts";
import type {
  DriftSchema,
  DriftReport,
  FieldDriftResult,
  ItemListDriftResult,
  ItemFieldStat,
  JsonDriftResult,
  SelectorRule,
  DetectDriftOptions,
} from "./types.ts";

/**
 * Normalizes string or object rule into a standard SelectorRule.
 */
export function normalizeRule(raw: SelectorRule | string): SelectorRule {
  if (typeof raw === "string") {
    return {
      selector: raw,
      required: false,
      minCount: 1,
    };
  }
  return {
    ...raw,
    minCount: raw.minCount !== undefined ? raw.minCount : 1,
  };
}

/**
 * Resolves a nested property path from a JSON object (e.g. "data.products").
 */
function getByPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const segments = path.split(".");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Runs a Cheerio selector, turning selector syntax errors into a message
 * instead of an exception so one bad schema entry cannot crash the run.
 */
function safeSelect<T>(run: () => T): { value: T; error?: undefined } | { value?: undefined; error: string } {
  try {
    return { value: run() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Expands parsed JSON-LD into the candidate objects it describes: top-level
 * arrays and `@graph` arrays are flattened so each node can be checked.
 */
function collectJsonLdNodes(
  data: unknown,
  out: Record<string, unknown>[] = [],
  inheritedContext?: unknown
): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    for (const entry of data) collectJsonLdNodes(entry, out, inheritedContext);
  } else if (data && typeof data === "object") {
    let obj = data as Record<string, unknown>;
    // Nodes inside @graph inherit the enclosing document's @context.
    if (obj["@context"] === undefined && inheritedContext !== undefined) {
      obj = { "@context": inheritedContext, ...obj };
    }
    out.push(obj);
    if (Array.isArray(obj["@graph"])) collectJsonLdNodes(obj["@graph"], out, obj["@context"]);
  }
  return out;
}

/**
 * Validates a JSON object against JsonRule.
 */
export function detectJsonDrift(
  data: unknown,
  schema: DriftSchema
): JsonDriftResult {
  const jsonRule = schema.json;
  if (!jsonRule) {
    return {
      passed: true,
      criticalFailure: false,
      missingKeys: [],
      arrayLengthChecks: [],
    };
  }

  const missingKeys: string[] = [];
  const arrayChecks: JsonDriftResult["arrayLengthChecks"] = [];
  let isCritical = false;
  const failureReasons: string[] = [];

  if (!data || typeof data !== "object") {
    return {
      passed: false,
      criticalFailure: true,
      missingKeys: jsonRule.requiredKeys || [],
      arrayLengthChecks: [],
      reason: "Provided payload is not a valid JSON object",
    };
  }

  if (jsonRule.requiredKeys && jsonRule.requiredKeys.length > 0) {
    for (const key of jsonRule.requiredKeys) {
      const val = getByPath(data, key);
      if (val === undefined || val === null || val === "") {
        missingKeys.push(key);
        isCritical = true;
      }
    }
    if (missingKeys.length > 0) {
      failureReasons.push(`Missing required keys: ${missingKeys.join(", ")}`);
    }
  }

  if (jsonRule.minItems) {
    const targetArray = getByPath(data, jsonRule.minItems.path);
    const count = Array.isArray(targetArray) ? targetArray.length : 0;
    const passed = count >= jsonRule.minItems.minCount;
    arrayChecks.push({
      path: jsonRule.minItems.path,
      foundCount: count,
      minCount: jsonRule.minItems.minCount,
      passed,
    });

    if (!passed) {
      isCritical = true;
      failureReasons.push(
        `Array at '${jsonRule.minItems.path}' has ${count} items, expected at least ${jsonRule.minItems.minCount}`
      );
    }
  }

  const passed = missingKeys.length === 0 && arrayChecks.every((c) => c.passed);

  return {
    passed,
    criticalFailure: isCritical,
    missingKeys,
    arrayLengthChecks: arrayChecks,
    reason: failureReasons.length > 0 ? failureReasons.join("; ") : undefined,
  };
}

/**
 * Main engine: evaluates HTML content against a drift schema.
 * Computes drift percentage and flags critical failures.
 */
export async function detectDrift(
  html: string,
  schema: DriftSchema,
  options: DetectDriftOptions = {}
): Promise<DriftReport> {
  const $ = cheerio.load(html || "");
  const fields: Record<string, FieldDriftResult> = {};
  const errors: string[] = [];
  const warnings: string[] = [];

  let totalChecks = 0;
  let passedChecks = 0;
  let failedChecks = 0;
  let hasCriticalFailure = false;

  // 1. Evaluate top-level selector rules
  if (schema.selectors) {
    for (const [fieldName, rawRule] of Object.entries(schema.selectors)) {
      totalChecks += 1;
      const rule = normalizeRule(rawRule);
      const selected = safeSelect(() => $(rule.selector));
      let patternRegex: RegExp | undefined;
      let configError: string | undefined;
      if (selected.error !== undefined) {
        configError = `Invalid selector '${rule.selector}': ${selected.error}`;
      } else if (rule.pattern) {
        try {
          patternRegex = new RegExp(rule.pattern);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          configError = `Invalid pattern /${rule.pattern}/: ${msg}`;
        }
      }
      if (configError) {
        failedChecks += 1;
        hasCriticalFailure = true;
        errors.push(`[CRITICAL] ${fieldName}: ${configError}`);
        fields[fieldName] = {
          field: fieldName,
          selector: rule.selector,
          found: false,
          count: 0,
          expectedMinCount: rule.minCount ?? 0,
          sampleValue: null,
          empty: true,
          required: Boolean(rule.required),
          passed: false,
          criticalFailure: true,
          reason: configError,
        };
        continue;
      }
      const $el = selected.value!;
      const count = $el.length;
      const found = count > 0;
      const required = Boolean(rule.required);
      const expectedMin = rule.minCount ?? (required ? 1 : 0);

      let sampleValue: string | null = null;
      if (found) {
        if (rule.attribute) {
          sampleValue = $el.first().attr(rule.attribute) ?? null;
        } else {
          sampleValue = $el.first().text().trim();
        }
      }

      const isEmpty = sampleValue == null || sampleValue === "";
      let passed = true;
      let critical = false;
      let reason: string | undefined;

      if (!found) {
        if (required) {
          passed = false;
          critical = true;
          reason = `Required selector '${rule.selector}' not found in DOM`;
        } else if (expectedMin > 0) {
          passed = false;
          reason = `Selector '${rule.selector}' not found (expected at least ${expectedMin})`;
        }
      } else {
        if (required && isEmpty && !rule.allowEmpty) {
          passed = false;
          critical = true;
          reason = `Required field '${fieldName}' exists but contains empty text/value`;
        } else if (count < expectedMin) {
          passed = false;
          if (required) critical = true;
          reason = `Expected min ${expectedMin} occurrences of '${rule.selector}', found ${count}`;
        } else if (rule.maxCount !== undefined && count > rule.maxCount) {
          passed = false;
          reason = `Expected max ${rule.maxCount} occurrences of '${rule.selector}', found ${count}`;
        } else if (patternRegex) {
          const matched = sampleValue !== null && patternRegex.test(sampleValue);
          if (!matched) {
            passed = false;
            if (required) critical = true;
            reason = `Value '${sampleValue}' did not match pattern /${rule.pattern}/`;
          }
        }
      }

      if (passed) {
        passedChecks += 1;
      } else {
        failedChecks += 1;
        if (critical) {
          hasCriticalFailure = true;
          errors.push(`[CRITICAL] ${fieldName}: ${reason}`);
        } else {
          warnings.push(`[DRIFT] ${fieldName}: ${reason}`);
        }
      }

      fields[fieldName] = {
        field: fieldName,
        selector: rule.selector,
        found,
        count,
        expectedMinCount: expectedMin,
        sampleValue,
        empty: isEmpty,
        required,
        patternMatched: patternRegex
          ? sampleValue !== null && patternRegex.test(sampleValue)
          : undefined,
        passed,
        criticalFailure: critical,
        reason,
      };
    }
  }

  // 2. Evaluate repeating item list rules
  let itemsResult: ItemListDriftResult | undefined;
  if (schema.items) {
    totalChecks += 1; // item container count check
    const container = schema.items.container;
    const minCount = schema.items.minCount ?? 1;
    const selectedItems = safeSelect(() => $(container));
    const $items = selectedItems.value ?? $([]);
    const count = $items.length;
    const itemContainerPassed = selectedItems.error === undefined && count >= minCount;
    let containerCritical = false;
    let containerReason: string | undefined;

    if (!itemContainerPassed) {
      containerCritical = true; // Listing dropped below minimum items
      hasCriticalFailure = true;
      failedChecks += 1;
      containerReason =
        selectedItems.error !== undefined
          ? `Invalid selector '${container}': ${selectedItems.error}`
          : `Found ${count} items for container '${container}', expected at least ${minCount}`;
      errors.push(`[CRITICAL] Items list: ${containerReason}`);
    } else {
      passedChecks += 1;
    }

    const fieldStats: Record<string, ItemFieldStat> = {};
    if (schema.items.fields && count > 0) {
      for (const [subField, rawSubRule] of Object.entries(schema.items.fields)) {
        totalChecks += 1;
        const subRule = normalizeRule(rawSubRule);
        const subRequired = Boolean(subRule.required);
        let presentCount = 0;

        const scan = safeSelect(() =>
          $items.each((_, el) => {
            const $target = $(el).find(subRule.selector);
            if ($target.length > 0) {
              const val = subRule.attribute
                ? $target.first().attr(subRule.attribute)
                : $target.first().text().trim();
              if (val && val.length > 0) {
                presentCount += 1;
              }
            }
          })
        );

        const passRate = (presentCount / count) * 100;
        // If required, must be present in all items (or minCount if 1)
        const subPassed =
          scan.error === undefined && (subRequired ? presentCount === count : presentCount > 0);
        let subCritical = false;
        let subReason: string | undefined;

        if (scan.error !== undefined) {
          failedChecks += 1;
          subCritical = true;
          hasCriticalFailure = true;
          subReason = `Invalid selector '${subRule.selector}': ${scan.error}`;
          errors.push(`[CRITICAL] ${subField}: ${subReason}`);
        } else if (!subPassed) {
          failedChecks += 1;
          if (subRequired) {
            subCritical = true;
            hasCriticalFailure = true;
            subReason = `Required item field '${subField}' present in only ${presentCount}/${count} items (${passRate.toFixed(1)}%)`;
            errors.push(`[CRITICAL] ${subField}: ${subReason}`);
          } else {
            subReason = `Item field '${subField}' present in only ${presentCount}/${count} items`;
            warnings.push(`[DRIFT] ${subField}: ${subReason}`);
          }
        } else {
          passedChecks += 1;
        }

        fieldStats[subField] = {
          presentCount,
          totalItems: count,
          passRatePercent: Number(passRate.toFixed(2)),
          required: subRequired || scan.error !== undefined,
          passed: subPassed,
          reason: subReason,
        };
      }
    }

    itemsResult = {
      container,
      count,
      minCount,
      passed: itemContainerPassed && Object.values(fieldStats).every((s) => s.passed),
      criticalFailure: containerCritical || Object.values(fieldStats).some((s) => !s.passed && s.required),
      reason: containerReason,
      itemFieldStats: Object.keys(fieldStats).length > 0 ? fieldStats : undefined,
    };
  }

  // 3. Evaluate JSON-LD or JSON rules if present
  let jsonResult: JsonDriftResult | undefined;
  if (schema.jsonLd) {
    totalChecks += 1;
    const scriptEls = $('script[type="application/ld+json"]');
    if (scriptEls.length === 0) {
      failedChecks += 1;
      hasCriticalFailure = true;
      errors.push("[CRITICAL] Expected <script type='application/ld+json'> not found in DOM");
      jsonResult = {
        passed: false,
        criticalFailure: true,
        missingKeys: schema.json?.requiredKeys || [],
        arrayLengthChecks: [],
        reason: "No application/ld+json script tag found in HTML",
      };
    } else {
      // Pages commonly carry several JSON-LD blocks (BreadcrumbList, Organization,
      // Product, ...) or a single block with an @graph array. Check every node.
      const nodes: Record<string, unknown>[] = [];
      const parseErrors: string[] = [];
      scriptEls.each((_, el) => {
        try {
          collectJsonLdNodes(JSON.parse($(el).text().trim()), nodes);
        } catch (err) {
          parseErrors.push(err instanceof Error ? err.message : String(err));
        }
      });

      if (nodes.length === 0) {
        failedChecks += 1;
        hasCriticalFailure = true;
        const msg =
          parseErrors.length > 0
            ? `Failed to parse JSON-LD: ${parseErrors.join("; ")}`
            : "JSON-LD script content is not a JSON object";
        errors.push(`[CRITICAL] ${msg}`);
        jsonResult = {
          passed: false,
          criticalFailure: true,
          missingKeys: schema.json?.requiredKeys || [],
          arrayLengthChecks: [],
          reason: msg,
        };
      } else {
        for (const msg of parseErrors) {
          warnings.push(`[DRIFT] Ignored malformed JSON-LD block: ${msg}`);
        }
        if (schema.json) {
          const results = nodes.map((node) => detectJsonDrift(node, schema));
          const failureScore = (r: JsonDriftResult) =>
            r.missingKeys.length + r.arrayLengthChecks.filter((c) => !c.passed).length;
          jsonResult =
            results.find((r) => r.passed) ??
            results.reduce((best, r) => (failureScore(r) < failureScore(best) ? r : best));
          if (jsonResult.passed) {
            passedChecks += 1;
          } else {
            failedChecks += 1;
            if (jsonResult.criticalFailure) {
              hasCriticalFailure = true;
              if (jsonResult.reason) errors.push(`[CRITICAL] ${jsonResult.reason}`);
            } else {
              if (jsonResult.reason) warnings.push(`[DRIFT] ${jsonResult.reason}`);
            }
          }
        } else {
          passedChecks += 1;
          jsonResult = {
            passed: true,
            criticalFailure: false,
            missingKeys: [],
            arrayLengthChecks: [],
          };
        }
      }
    }
  } else if (schema.json) {
    totalChecks += 1;
    // Direct JSON check (e.g. if html is actually JSON or payload tested directly)
    try {
      const parsed = JSON.parse(html);
      jsonResult = detectJsonDrift(parsed, schema);
      if (jsonResult.passed) {
        passedChecks += 1;
      } else {
        failedChecks += 1;
        if (jsonResult.criticalFailure) {
          hasCriticalFailure = true;
          if (jsonResult.reason) errors.push(`[CRITICAL] ${jsonResult.reason}`);
        }
      }
    } catch {
      failedChecks += 1;
      hasCriticalFailure = true;
      errors.push("[CRITICAL] Input payload is not valid JSON");
      jsonResult = {
        passed: false,
        criticalFailure: true,
        missingKeys: schema.json.requiredKeys || [],
        arrayLengthChecks: [],
        reason: "Payload is not valid JSON",
      };
    }
  }

  // 4. Calculate drift percentage
  const driftPercent =
    totalChecks === 0
      ? 0
      : Number(((failedChecks / totalChecks) * 100).toFixed(2));

  const maxAllowed =
    options.maxAllowedDriftPercent ?? schema.maxAllowedDriftPercent ?? 0;

  const passed = !hasCriticalFailure && driftPercent <= maxAllowed;

  // 5. Snapshot on drift
  let snapshotPath: string | undefined;
  if (!passed && options.saveSnapshotOnDrift !== false && html.length > 0) {
    try {
      snapshotPath = await saveSnapshot(html, {
        snapshotDir: options.snapshotDir,
        name: schema.name || "drift",
      });
    } catch (snapErr) {
      const msg = snapErr instanceof Error ? snapErr.message : String(snapErr);
      warnings.push(`Failed to save drift snapshot: ${msg}`);
    }
  }

  return {
    schemaName: schema.name,
    passed,
    criticalFailure: hasCriticalFailure,
    driftPercent,
    totalChecks,
    passedChecks,
    failedChecks,
    fields,
    items: itemsResult,
    json: jsonResult,
    snapshotPath,
    timestamp: new Date().toISOString(),
    errors,
    warnings,
  };
}
