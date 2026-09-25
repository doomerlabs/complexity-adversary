export const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".py",
  ".rs",
]);

export interface StructuralClone {
  path: string;
  changed: { line: number; endLine: number };
  existing: { line: number; endLine: number };
  calls: string[];
}

export interface SourceRevision {
  path: string;
  current: string;
  previous?: string;
  changedLines: Set<number>;
  status: "added" | "modified" | "unbaselined" | "repository";
}

export interface FunctionMetrics {
  key: string;
  name: string;
  line: number;
  endLine: number;
  cyclomatic: number;
  cognitive: number;
  nesting: number;
  loc: number;
  parameters: number;
  branches: number;
  booleanTerms: number;
  errorPaths: number;
  hiddenState: number;
  responsibilities: string[];
  configSurface: number;
  recursiveCalls: number;
  calls: string[];
  wrapper: boolean;
  wrapperKind?: "call" | "jsx";
  wrapperTarget?: string;
  references: number;
  genericParameters: number;
}

export interface AbstractionMetrics {
  interfaces: Array<{ name: string; line: number; implementations: number }>;
  factories: Array<{ name: string; line: number; constructedTypes: string[] }>;
  genericDeclarations: Array<{ name: string; line: number; parameters: number; references: number }>;
  wrappers: Array<{
    name: string;
    line: number;
    endLine: number;
    target?: string;
    kind: "call" | "jsx";
    references: number;
  }>;
}

export interface FileMetrics {
  path: string;
  functions: FunctionMetrics[];
  abstractions: AbstractionMetrics;
  parseError?: string;
}

export interface FunctionDelta {
  path: string;
  current: FunctionMetrics;
  previous?: FunctionMetrics;
  changed: boolean;
  anchorLine: number;
}

export interface Analysis {
  mode: "diff" | "repository";
  base?: string;
  files: SourceRevision[];
  current: FileMetrics[];
  previous: FileMetrics[];
  deltas: FunctionDelta[];
  changedTestFiles: number;
  changedSourceFiles: number;
  aggregateBranchDelta: number;
  aggregateLocDelta: number;
  structuralClones: StructuralClone[];
}
