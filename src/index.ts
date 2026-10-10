export {
  detectDrift,
  detectJsonDrift,
  normalizeRule,
} from "./detector.ts";

export { saveSnapshot } from "./snapshot.ts";

export type {
  DriftSchema,
  SelectorRule,
  ItemListRule,
  JsonRule,
  DriftReport,
  FieldDriftResult,
  ItemListDriftResult,
  ItemFieldStat,
  JsonDriftResult,
  DetectDriftOptions,
} from "./types.ts";
