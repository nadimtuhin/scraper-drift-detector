export interface SelectorRule {
  /** CSS selector to query in DOM */
  selector: string;
  /** If true, missing element or empty text/value is a critical failure (default: false) */
  required?: boolean;
  /** Minimum number of matching elements required (default: 1 if required, else 0) */
  minCount?: number;
  /** Maximum number of matching elements permitted */
  maxCount?: number;
  /** Extract and validate attribute value instead of inner text (e.g. 'href', 'src', 'content') */
  attribute?: string;
  /** Regular expression pattern string that text/attribute must match */
  pattern?: string;
  /** If true, allow empty string even if required: true (default: false) */
  allowEmpty?: boolean;
  /** Human-readable field description */
  description?: string;
}

export interface ItemListRule {
  /** Selector matching each repeating item container (e.g. '.product-card', 'table tbody tr') */
  container: string;
  /** Minimum number of items expected on the page */
  minCount?: number;
  /** Relative selectors to validate within each item element */
  fields?: Record<string, SelectorRule | string>;
}

export interface JsonRule {
  /** Top-level or nested keys required in the JSON object */
  requiredKeys?: string[];
  /** Expected minimum array lengths at specific paths */
  minItems?: {
    path: string;
    minCount: number;
  };
}

export interface DriftSchema {
  name?: string;
  description?: string;
  version?: string;
  targetUrl?: string;
  /** Tolerance threshold (0-100). If drift % exceeds this, marks evaluation as failed. Default: 0 */
  maxAllowedDriftPercent?: number;
  /** Top-level DOM selectors to validate */
  selectors?: Record<string, SelectorRule | string>;
  /** Repeating item list / table validation */
  items?: ItemListRule;
  /** JSON payload or embedded JSON-LD validation */
  json?: JsonRule;
  /** If true, extracts and validates embedded <script type="application/ld+json"> */
  jsonLd?: boolean;
}

export interface FieldDriftResult {
  field: string;
  selector: string;
  found: boolean;
  count: number;
  expectedMinCount: number;
  sampleValue?: string | null;
  empty: boolean;
  required: boolean;
  patternMatched?: boolean;
  passed: boolean;
  criticalFailure: boolean;
  reason?: string;
}

export interface ItemFieldStat {
  presentCount: number;
  totalItems: number;
  passRatePercent: number;
  required: boolean;
  passed: boolean;
  reason?: string;
}

export interface ItemListDriftResult {
  container: string;
  count: number;
  minCount: number;
  passed: boolean;
  criticalFailure: boolean;
  reason?: string;
  itemFieldStats?: Record<string, ItemFieldStat>;
}

export interface JsonDriftResult {
  passed: boolean;
  criticalFailure: boolean;
  missingKeys: string[];
  arrayLengthChecks: Array<{
    path: string;
    foundCount: number;
    minCount: number;
    passed: boolean;
  }>;
  reason?: string;
}

export interface DriftReport {
  schemaName?: string;
  passed: boolean;
  criticalFailure: boolean;
  driftPercent: number;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  fields: Record<string, FieldDriftResult>;
  items?: ItemListDriftResult;
  json?: JsonDriftResult;
  snapshotPath?: string;
  timestamp: string;
  errors: string[];
  warnings: string[];
}

export interface DetectDriftOptions {
  snapshotDir?: string;
  saveSnapshotOnDrift?: boolean;
  maxAllowedDriftPercent?: number;
}
