import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";
import {
  type AbstractionMetrics,
  type Analysis,
  type FileMetrics,
  type FunctionDelta,
  type FunctionMetrics,
} from "./types.js";
import { type Discovery } from "./discover.js";
import { findNewStructuralClones } from "./structural-clones.js";

interface Position {
  line: number;
  column: number;
}

interface AstNode {
  type: string;
  loc?: { start: Position; end: Position };
  range?: [number, number];
  [key: string]: unknown;
}

interface FunctionRecord {
  node: AstNode;
  parent?: AstNode;
  name: string;
  line: number;
  endLine: number;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);
const CONTROL_TYPES = new Set([
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "TryStatement",
  "CatchClause",
  "ConditionalExpression",
]);
const BRANCH_TYPES = new Set([
  ...CONTROL_TYPES,
  "SwitchCase",
  "LogicalExpression",
]);

export function analyzeDiscovery(discovery: Discovery): Analysis {
  const current = discovery.files.map((file) => analyzeFile(file.path, file.current));
  const previous = discovery.files
    .filter((file) => file.previous !== undefined)
    .map((file) => analyzeFile(file.path, file.previous ?? ""));
  const previousByPath = new Map(previous.map((file) => [file.path, file]));
  const deltas: FunctionDelta[] = [];

  for (const currentFile of current) {
    const revision = discovery.files.find((file) => file.path === currentFile.path);
    const previousFunctions = new Map(
      (previousByPath.get(currentFile.path)?.functions ?? []).map((fn) => [fn.key, fn]),
    );
    for (const fn of currentFile.functions) {
      const changed =
        revision?.status === "repository" ||
        revision?.status === "added" ||
        intersects(revision?.changedLines ?? new Set<number>(), fn.line, fn.endLine);
      if (changed) {
        deltas.push({
          path: currentFile.path,
          current: fn,
          previous: previousFunctions.get(fn.key),
          changed,
          anchorLine: changedFunctionLine(revision, fn),
        });
      }
    }
  }

  deltas.sort((left, right) =>
    left.path.localeCompare(right.path) || left.current.line - right.current.line,
  );

  return {
    ...discovery,
    current,
    previous,
    deltas,
    aggregateBranchDelta: sumDelta(deltas, "branches"),
    aggregateLocDelta: sumDelta(deltas, "loc"),
    structuralClones: findNewStructuralClones(discovery.files),
  };
}

function changedFunctionLine(revision: Discovery["files"][number] | undefined, fn: FunctionMetrics): number {
  if (revision?.status !== "modified") return fn.line;
  const lines = revision.current.split("\n");
  const changed = [...revision.changedLines]
    .filter((line) => line >= fn.line && line <= fn.endLine)
    .sort((a, b) => a - b);
  // Prefer the changed decision or error statement that explains the metric delta.
  return changed.find((line) => /^\s*(?:}\s*)?(?:else\b|if\b|for\b|while\b|switch\b|try\b|catch\b|finally\b|throw\b)/.test(lines[line - 1] ?? ""))
    ?? changed[0]
    ?? fn.line;
}

export function analyzeFile(path: string, source: string): FileMetrics {
  let ast: AstNode;
  try {
    const parsed = parser.parseForESLint(source, {
      filePath: path,
      loc: true,
      range: true,
      comment: false,
      tokens: false,
      jsx: /\.[jt]sx$/i.test(path),
      ecmaVersion: "latest",
      sourceType: "module",
    });
    ast = parsed.ast as unknown as AstNode;
  } catch (error) {
    return {
      path,
      functions: [],
      abstractions: emptyAbstractions(),
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  const analyzerMetrics = establishedMetrics(path, source);
  const moduleMutable = moduleMutableNames(ast);
  const records = collectFunctions(ast);
  const nameCounts = new Map<string, number>();
  const functions = records.map((record) => {
    const ordinal = (nameCounts.get(record.name) ?? 0) + 1;
    nameCounts.set(record.name, ordinal);
    return structuralMetrics(record, ast, analyzerMetrics, moduleMutable, ordinal);
  });

  return {
    path,
    functions,
    abstractions: abstractionMetrics(ast, functions),
  };
}

function establishedMetrics(path: string, source: string): Array<{
  kind: "cyclomatic" | "cognitive";
  line: number;
  value: number;
}> {
  const linter = new Linter();
  const messages = linter.verify(
    source,
    [
      {
        files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
        languageOptions: {
          parser,
          parserOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            ecmaFeatures: { jsx: true },
          },
        },
        plugins: { sonarjs },
        rules: {
          complexity: ["error", 0],
          "sonarjs/cognitive-complexity": ["error", 0],
        },
      },
    ] as never,
    { filename: path },
  );

  const metrics: Array<{ kind: "cyclomatic" | "cognitive"; line: number; value: number }> = [];
  for (const message of messages) {
    if (message.ruleId === "complexity") {
      const value = /complexity of (\d+)/i.exec(message.message)?.[1];
      if (value !== undefined) metrics.push({ kind: "cyclomatic", line: message.line, value: Number(value) });
    }
    if (message.ruleId === "sonarjs/cognitive-complexity") {
      const value = /from (\d+) to/i.exec(message.message)?.[1];
      if (value !== undefined) metrics.push({ kind: "cognitive", line: message.line, value: Number(value) });
    }
  }
  return metrics;
}

function structuralMetrics(
  record: FunctionRecord,
  ast: AstNode,
  established: ReturnType<typeof establishedMetrics>,
  moduleMutable: Set<string>,
  ordinal: number,
): FunctionMetrics {
  const calls: string[] = [];
  const responsibilities = new Set<string>();
  const configProperties = new Set<string>();
  let nesting = 0;
  let branches = 0;
  let booleanTerms = 0;
  let errorPaths = 0;
  let hiddenState = 0;
  let recursiveCalls = 0;
  let callCount = 0;
  let statementCount = 0;

  walkFunction(record.node, (node, parent, depth) => {
    if (CONTROL_TYPES.has(node.type)) nesting = Math.max(nesting, depth + 1);
    if (BRANCH_TYPES.has(node.type)) branches += 1;
    if (node.type === "LogicalExpression") booleanTerms = Math.max(booleanTerms, logicalTerms(node));
    if (node.type === "ThrowStatement" || node.type === "CatchClause") errorPaths += 1;
    if (node.type === "TryStatement" && node.finalizer !== null && node.finalizer !== undefined) errorPaths += 1;
    if (node.type.endsWith("Statement") && parent === record.node.body) statementCount += 1;

    if (node.type === "CallExpression") {
      callCount += 1;
      const name = calleeName(node.callee);
      if (name !== undefined) {
        calls.push(name);
        if (simpleName(name) === record.name) recursiveCalls += 1;
        const responsibility = classifyResponsibility(name);
        if (responsibility !== undefined) responsibilities.add(responsibility);
      }
    }

    if (node.type === "AssignmentExpression" || node.type === "UpdateExpression") {
      const target = node.type === "AssignmentExpression" ? node.left : node.argument;
      if (isHiddenStateTarget(target, moduleMutable)) hiddenState += 1;
    }

    if (node.type === "MemberExpression") {
      const object = identifierName(node.object);
      const property = propertyName(node.property);
      if (object !== undefined && /^(?:config|options|opts|settings|flags)$/i.test(object) && property !== undefined) {
        configProperties.add(property);
      }
    }
  });

  const rangeMetrics = established.filter(
    (metric) => metric.line >= record.line && metric.line <= record.endLine,
  );
  const cyclomatic = closestMetric(rangeMetrics, "cyclomatic", record.line) ?? 1;
  const cognitive = closestMetric(rangeMetrics, "cognitive", record.line) ?? 0;
  const genericParameters = typeParameterCount(record.node);
  const jsxTarget = directJsxDelegation(record.node);
  const callWrapper = callCount === 1 && branches === 0 && statementCount <= 2;

  return {
    key: `${record.name}#${ordinal}`,
    name: record.name,
    line: record.line,
    endLine: record.endLine,
    cyclomatic,
    cognitive,
    nesting,
    loc: Math.max(1, record.endLine - record.line + 1),
    parameters: Array.isArray(record.node.params) ? record.node.params.length : 0,
    branches,
    booleanTerms,
    errorPaths,
    hiddenState,
    responsibilities: [...responsibilities].sort(),
    configSurface: configProperties.size,
    recursiveCalls,
    calls: [...new Set(calls)].sort(),
    wrapper: callWrapper || jsxTarget !== undefined,
    wrapperKind: jsxTarget !== undefined ? "jsx" : callWrapper ? "call" : undefined,
    wrapperTarget: jsxTarget ?? (callWrapper ? calls[0] : undefined),
    references: Math.max(0, countSymbol(ast, record.name) - 1),
    genericParameters,
  };
}

function collectFunctions(ast: AstNode): FunctionRecord[] {
  const records: FunctionRecord[] = [];
  walk(ast, (node, parent) => {
    if (!FUNCTION_TYPES.has(node.type) || node.loc === undefined) return;
    records.push({
      node,
      parent,
      name: functionName(node, parent),
      line: node.loc.start.line,
      endLine: node.loc.end.line,
    });
  });
  records.sort((left, right) => left.line - right.line || left.endLine - right.endLine);
  return records;
}

function functionName(node: AstNode, parent?: AstNode): string {
  const own = identifierName(node.id);
  if (own !== undefined) return own;
  if (parent?.type === "VariableDeclarator") return identifierName(parent.id) ?? anonymousName(node);
  if (parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition" || parent?.type === "Property") {
    return propertyName(parent.key) ?? anonymousName(node);
  }
  return anonymousName(node);
}

function anonymousName(node: AstNode): string {
  return `<anonymous@${node.loc?.start.line ?? 0}>`;
}

function abstractionMetrics(ast: AstNode, functions: FunctionMetrics[]): AbstractionMetrics {
  const interfaces: AbstractionMetrics["interfaces"] = [];
  const factories: AbstractionMetrics["factories"] = [];
  const genericDeclarations: AbstractionMetrics["genericDeclarations"] = [];
  const implementationCounts = new Map<string, number>();

  walk(ast, (node) => {
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      for (const item of arrayNodes(node.implements)) {
        const name = identifierName(item.expression) ?? propertyName(item.id);
        if (name !== undefined) implementationCounts.set(name, (implementationCounts.get(name) ?? 0) + 1);
      }
    }
  });

  walk(ast, (node, parent) => {
    if (node.type === "TSInterfaceDeclaration" && node.loc !== undefined) {
      const name = identifierName(node.id) ?? "<interface>";
      interfaces.push({ name, line: node.loc.start.line, implementations: implementationCounts.get(name) ?? 0 });
    }
    const declarationName = declarationIdentifier(node, parent);
    const parameters = typeParameterCount(node);
    if (declarationName !== undefined && parameters > 0 && node.loc !== undefined) {
      genericDeclarations.push({
        name: declarationName,
        line: node.loc.start.line,
        parameters,
        references: Math.max(0, countIdentifier(ast, declarationName) - 1),
      });
    }
  });

  const records = collectFunctions(ast);
  for (const record of records) {
    if (!/^(?:create|make|build|resolve|factory)/i.test(record.name)) continue;
    const constructed = new Set<string>();
    walkFunction(record.node, (node) => {
      if (node.type === "NewExpression") {
        const name = calleeName(node.callee);
        if (name !== undefined) constructed.add(name);
      }
    });
    if (constructed.size > 0) {
      factories.push({ name: record.name, line: record.line, constructedTypes: [...constructed].sort() });
    }
  }

  return {
    interfaces: interfaces.sort((a, b) => a.line - b.line),
    factories: factories.sort((a, b) => a.line - b.line),
    genericDeclarations: dedupeBy(genericDeclarations, (item) => `${item.name}:${item.line}`),
    wrappers: functions
      .filter((fn) => fn.wrapper)
      .map((fn) => ({
        name: fn.name,
        line: fn.line,
        endLine: fn.endLine,
        target: fn.wrapperTarget,
        kind: fn.wrapperKind ?? "call",
        references: fn.references,
      })),
  };
}

function directJsxDelegation(node: AstNode): string | undefined {
  const body = isNode(node.body) ? node.body : undefined;
  if (body === undefined) return undefined;

  let returned: AstNode | undefined;
  if (body.type === "JSXElement") {
    returned = body;
  } else if (body.type === "BlockStatement") {
    const statements = arrayNodes(body.body);
    if (statements.length !== 1 || statements[0]?.type !== "ReturnStatement") return undefined;
    returned = isNode(statements[0].argument) ? statements[0].argument : undefined;
  }
  if (returned?.type !== "JSXElement") return undefined;

  const opening = isNode(returned.openingElement) ? returned.openingElement : undefined;
  if (opening === undefined || hasMeaningfulJsxAttributes(opening)) return undefined;
  if (hasMeaningfulJsxChildren(returned)) return undefined;
  return jsxElementName(opening.name);
}

function hasMeaningfulJsxAttributes(opening: AstNode): boolean {
  for (const attribute of arrayNodes(opening.attributes)) {
    if (attribute.type === "JSXSpreadAttribute") return true;
    if (attribute.type !== "JSXAttribute") return true;
    const name = jsxElementName(attribute.name);
    if (name === undefined) return true;
    if (/^on[A-Z]/.test(name) || /^(?:role|tabIndex|alt|href|htmlFor)$/i.test(name) || /^aria-/i.test(name)) {
      return true;
    }
    if (attribute.value === null || attribute.value === undefined) return true;
    const value = isNode(attribute.value) ? attribute.value : undefined;
    if (value?.type === "Literal") continue;
    if (value?.type !== "JSXExpressionContainer") return true;
    const expression = isNode(value.expression) ? value.expression : undefined;
    if (expression?.type !== "Literal") return true;
  }
  return false;
}

function hasMeaningfulJsxChildren(element: AstNode): boolean {
  for (const child of arrayNodes(element.children)) {
    if (child.type === "JSXText") {
      if (typeof child.value === "string" && child.value.trim() !== "") return true;
      continue;
    }
    if (child.type !== "JSXExpressionContainer") return true;
    const expression = isNode(child.expression) ? child.expression : undefined;
    if (expression?.type === "JSXEmptyExpression") continue;
    if (identifierName(expression) !== "children") return true;
  }
  return false;
}

function jsxElementName(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === "JSXIdentifier") return typeof value.name === "string" ? value.name : undefined;
  if (value.type === "JSXMemberExpression") {
    const object = jsxElementName(value.object);
    const property = jsxElementName(value.property);
    return object !== undefined && property !== undefined ? `${object}.${property}` : undefined;
  }
  if (value.type === "JSXNamespacedName") {
    const namespace = jsxElementName(value.namespace);
    const name = jsxElementName(value.name);
    return namespace !== undefined && name !== undefined ? `${namespace}:${name}` : undefined;
  }
  return identifierName(value);
}

function walkFunction(
  root: AstNode,
  visit: (node: AstNode, parent: unknown, controlDepth: number) => void,
): void {
  function descend(node: AstNode, parent: unknown, depth: number): void {
    visit(node, parent, depth);
    for (const child of childNodes(node)) {
      if (child !== root && FUNCTION_TYPES.has(child.type)) continue;
      const nextDepth = CONTROL_TYPES.has(node.type) ? depth + 1 : depth;
      descend(child, node, nextDepth);
    }
  }
  descend(root, undefined, 0);
}

function walk(root: AstNode, visit: (node: AstNode, parent?: AstNode) => void): void {
  function descend(node: AstNode, parent?: AstNode): void {
    visit(node, parent);
    for (const child of childNodes(node)) descend(child, node);
  }
  descend(root);
}

function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "range", "tokens", "comments", "parent"].includes(key)) continue;
    if (isNode(value)) children.push(value);
    else if (Array.isArray(value)) children.push(...value.filter(isNode));
  }
  return children;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function arrayNodes(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function logicalTerms(node: AstNode): number {
  if (node.type !== "LogicalExpression") return 1;
  return logicalTerms(asNode(node.left)) + logicalTerms(asNode(node.right));
}

function asNode(value: unknown): AstNode {
  return isNode(value) ? value : { type: "Unknown" };
}

function calleeName(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === "Identifier") return identifierName(value);
  if (value.type === "MemberExpression") {
    const object = calleeName(value.object);
    const property = propertyName(value.property);
    if (object !== undefined && property !== undefined) return `${object}.${property}`;
    return property;
  }
  return undefined;
}

function simpleName(name: string): string {
  return name.split(".").pop() ?? name;
}

function classifyResponsibility(name: string): string | undefined {
  const simple = simpleName(name);
  if (/^(?:parse|decode|read|load|deserialize)/i.test(simple)) return "parsing";
  if (/^(?:validate|verify|check|assert|ensure)/i.test(simple)) return "validation";
  if (/^(?:run|execute|dispatch|orchestrate|coordinate|handle|process)/i.test(simple)) return "orchestration";
  if (/^(?:save|write|store|persist|insert|update|delete|remove|commit)/i.test(simple)) return "persistence";
  if (/^(?:format|render|stringify|serialize|present)/i.test(simple)) return "formatting";
  return undefined;
}

function moduleMutableNames(ast: AstNode): Set<string> {
  const names = new Set<string>();
  const body = Array.isArray(ast.body) ? ast.body.filter(isNode) : [];
  for (const statement of body) {
    if (statement.type !== "VariableDeclaration" || statement.kind === "const") continue;
    for (const declaration of arrayNodes(statement.declarations)) {
      const name = identifierName(declaration.id);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

function isHiddenStateTarget(value: unknown, moduleMutable: Set<string>): boolean {
  if (!isNode(value)) return false;
  if (value.type === "Identifier") return moduleMutable.has(identifierName(value) ?? "");
  if (value.type === "MemberExpression") {
    const object = identifierName(value.object);
    return object === "this" || object === "global" || object === "globalThis" || object === "state" || object === "cache";
  }
  return false;
}

function identifierName(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  return value.type === "Identifier" || value.type === "PrivateIdentifier"
    ? typeof value.name === "string" ? value.name : undefined
    : value.type === "ThisExpression" ? "this" : undefined;
}

function propertyName(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === "Identifier" || value.type === "PrivateIdentifier") return identifierName(value);
  if (value.type === "Literal") return typeof value.value === "string" ? value.value : undefined;
  return undefined;
}

function declarationIdentifier(node: AstNode, parent?: AstNode): string | undefined {
  return identifierName(node.id) ??
    (parent?.type === "VariableDeclarator" ? identifierName(parent.id) : undefined);
}

function typeParameterCount(node: AstNode): number {
  const declaration = isNode(node.typeParameters) ? node.typeParameters : undefined;
  return declaration === undefined ? 0 : arrayNodes(declaration.params).length;
}

function countIdentifier(ast: AstNode, name: string): number {
  let count = 0;
  walk(ast, (node) => {
    if (node.type === "Identifier" && identifierName(node) === name) count += 1;
  });
  return count;
}

function countSymbol(ast: AstNode, name: string): number {
  let count = 0;
  walk(ast, (node, parent) => {
    if (node.type === "Identifier" && identifierName(node) === name) count += 1;
    if (node.type === "JSXIdentifier" && parent?.type === "JSXOpeningElement" && parent.name === node && jsxElementName(node) === name) {
      count += 1;
    }
  });
  return count;
}

function closestMetric(
  metrics: ReturnType<typeof establishedMetrics>,
  kind: "cyclomatic" | "cognitive",
  startLine: number,
): number | undefined {
  return metrics
    .filter((metric) => metric.kind === kind)
    .sort((left, right) => Math.abs(left.line - startLine) - Math.abs(right.line - startLine))[0]?.value;
}

function intersects(lines: Set<number>, start: number, end: number): boolean {
  for (const line of lines) if (line >= start && line <= end) return true;
  return false;
}

function sumDelta(deltas: FunctionDelta[], key: "branches" | "loc"): number {
  return deltas.reduce((sum, delta) => sum + delta.current[key] - (delta.previous?.[key] ?? 0), 0);
}

function emptyAbstractions(): AbstractionMetrics {
  return { interfaces: [], factories: [], genericDeclarations: [], wrappers: [] };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
