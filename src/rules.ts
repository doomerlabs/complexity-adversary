import { type RuleContext } from "@adversarylabs/sdk";
import { type Analysis, type FileMetrics, type FunctionDelta, type FunctionMetrics } from "./types.js";

interface Candidate {
  delta: FunctionDelta;
  reason: string;
}

interface DesignSignals {
  premature: Array<{ path: string; line: number; kind: string; name: string; detail: string }>;
  trivialWrappers: Array<{ path: string; line: number; endLine: number; name: string; target?: string }>;
  wrapperGrowth: number;
  chain?: { path: string; names: string[]; line: number };
  complexityPressure: number;
}

export function reviewComplexity(ctx: RuleContext, analysis: Analysis): void {
  // A new file has no previous implementation to compare. Keep architectural
  // signals, but do not describe its initial metrics as complexity growth.
  const addedFiles = new Set(analysis.files.filter((file) => file.status === "added").map((file) => file.path));
  const metricDeltas = analysis.deltas.filter((delta) => !addedFiles.has(delta.path));
  const cyclomatic = analysis.mode === "diff" ? metricDeltas.filter(isCyclomaticIncrease) : [];
  const cognitive = analysis.mode === "diff" ? metricDeltas.filter(isCognitiveIncrease) : [];
  const nesting = metricDeltas.filter((delta) => increased(delta, "nesting", 2, 4, 5));
  const growth = metricDeltas.filter(isLargeGrowth);
  const parameters = metricDeltas.filter((delta) => increased(delta, "parameters", 3, 7, 8));
  const responsibilities = metricDeltas.filter(isResponsibilityExpansion);
  const hiddenState = metricDeltas.filter((delta) => increased(delta, "hiddenState", 2, 4, 5));
  const magicConditions = metricDeltas.filter((delta) => increased(delta, "booleanTerms", 2, 5, 6));
  const configuration = metricDeltas.filter((delta) => increased(delta, "configSurface", 4, 8, 10));
  const recursion = metricDeltas.filter(isRecursionRisk);
  const errors = metricDeltas.filter((delta) => increased(delta, "errorPaths", 2, 4, 5));
  const design = designSignals(analysis, cyclomatic.length + cognitive.length + nesting.length);
  const comparableBranchDelta = metricDeltas.reduce((sum, delta) => sum + branchDelta(delta), 0);
  const branchWithoutTests =
    analysis.mode === "diff" &&
    comparableBranchDelta >= 6 &&
    analysis.changedSourceFiles > 0 &&
    analysis.changedTestFiles === 0;
  const aiOverengineering = overengineeringScore(analysis, design, growth, responsibilities) >= 6;
  const structuralClones = analysis.structuralClones;

  emitControlFlowFindings(ctx, { cyclomatic, cognitive, nesting, errors });
  emitMetricFinding(ctx, {
    ruleId: "complexity.large-function-growth",
    title: "Functions grew faster than their behavior appears to require",
    category: "maintainability",
    candidates: growth.map((delta) => ({ delta, reason: `${metricSentence(delta, "loc", "LOC")} Branches: ${before(delta, "branches")} → ${delta.current.branches}.` })),
    why: "Rapid function growth often signals that orchestration, policy, and mechanics are being combined in one place.",
    recommendation: "Keep the high-level flow visible and move cohesive policy or mechanics behind names that explain their purpose.",
  });
  emitMetricFinding(ctx, {
    ruleId: "complexity.parameter-growth",
    title: "Parameter lists expanded materially",
    category: "design",
    candidates: parameters.map((delta) => ({ delta, reason: metricSentence(delta, "parameters", "Parameters") })),
    why: "A growing positional parameter list can expose missing domain boundaries and makes call sites easier to misuse.",
    recommendation: "If these values travel together, consider a focused domain input object; do not introduce one solely to hide the count.",
    confidence: "medium",
  });

  if (aiOverengineering) {
    emitOverengineering(ctx, analysis, design, growth, responsibilities);
  } else {
    emitPrematureAbstraction(ctx, design);
    emitIndirection(ctx, design);
  }
  emitTrivialWrappers(ctx, design);
  emitStructuralClones(ctx, structuralClones);

  if (branchWithoutTests) {
    const evidence = metricDeltas
      .filter((delta) => delta.current.branches > (delta.previous?.branches ?? 0))
      .sort((a, b) => branchDelta(b) - branchDelta(a))
      .slice(0, 4)
      .map((delta) => functionEvidence(delta, `Decision points increased by ${branchDelta(delta)} without a changed test file.`));
    ctx.finding({
      ruleId: "complexity.branch-without-tests",
      title: "Control-flow growth is not accompanied by test changes",
      category: "testing",
      severity: "medium",
      confidence: "high",
      summary: `Changed functions added ${comparableBranchDelta} structural decision points, but this change does not modify tests.`,
      whyItMatters: "New paths are where boundary conditions and regressions concentrate; unchanged tests provide little evidence that those paths were considered.",
      impact: "Reviewers must reason about the additional branches manually, and future refactors can break an unexercised path silently.",
      evidence,
      recommendation: "Add focused tests for the new decisions and error paths, especially combinations that are not covered by the happy path.",
      remediation: { complexity: "medium" },
    });
  }

  emitMetricFinding(ctx, {
    ruleId: "complexity.responsibility-expansion",
    title: "Functions accumulated multiple engineering responsibilities",
    category: "design",
    candidates: responsibilities.map((delta) => ({
      delta,
      reason: `Responsibilities: ${list(delta.previous?.responsibilities ?? []) || "none"} → ${list(delta.current.responsibilities)}.`,
    })),
    why: "Combining parsing, validation, orchestration, persistence, and presentation makes changes harder to isolate and test.",
    recommendation: "Separate only the responsibilities that change independently, keeping the orchestration readable rather than creating layers mechanically.",
    confidence: "medium",
  });
  emitMetricFinding(ctx, {
    ruleId: "complexity.hidden-state",
    title: "Changed code relies on more hidden mutable state",
    category: "design",
    candidates: hiddenState.map((delta) => ({ delta, reason: metricSentence(delta, "hiddenState", "Hidden-state writes") })),
    why: "Mutable module, instance, or cache state creates behavior that is not visible in a function's inputs and outputs.",
    recommendation: "Make state transitions explicit where practical and avoid behavior flags whose combinations create implicit modes.",
    confidence: "medium",
  });
  emitMetricFinding(ctx, {
    ruleId: "complexity.magic-conditions",
    title: "Boolean policy became difficult to read inline",
    category: "maintainability",
    candidates: magicConditions.map((delta) => ({ delta, reason: metricSentence(delta, "booleanTerms", "Largest boolean expression") })),
    why: "Long boolean expressions hide the policy being applied and make truth-table gaps easy to miss.",
    recommendation: "Extract named predicates that describe the policy, and test their boundary combinations directly.",
  });
  emitMetricFinding(ctx, {
    ruleId: "complexity.configuration-explosion",
    title: "Configuration surface expanded rapidly",
    category: "design",
    candidates: configuration.map((delta) => ({ delta, reason: metricSentence(delta, "configSurface", "Configuration fields read") })),
    why: "A rapidly growing set of optional controls creates implicit modes and a feature matrix that becomes difficult to validate.",
    recommendation: "Group configuration by cohesive behavior and remove combinations that are not intentionally supported.",
    confidence: "medium",
  });
  emitMetricFinding(ctx, {
    ruleId: "complexity.recursion-risk",
    title: "Recursive control flow became harder to reason about",
    category: "correctness",
    candidates: recursion.map((delta) => ({ delta, reason: metricSentence(delta, "recursiveCalls", "Recursive paths") })),
    why: "Multiple recursive paths make termination, repeated work, and partial failure harder to establish locally.",
    recommendation: "Make the termination invariant explicit and consider an iterative worklist when several recursive branches share state.",
    confidence: "medium",
  });
  addPositiveSignals(ctx, analysis);
  addOverallReview(ctx, analysis, {
    materialFindings: cyclomatic.length + cognitive.length + nesting.length + growth.length + responsibilities.length + (design.trivialWrappers.length > 0 ? 1 : 0) + structuralClones.length + (aiOverengineering ? 2 : 0),
    aiOverengineering,
  });
}

function emitControlFlowFindings(
  ctx: RuleContext,
  signals: Record<"cyclomatic" | "cognitive" | "nesting" | "errors", FunctionDelta[]>,
): void {
  const byFile = new Map<string, Map<FunctionDelta, string[]>>();
  for (const [kind, label, metric] of [
    ["cyclomatic", "Cyclomatic", "cyclomatic"],
    ["cognitive", "Cognitive", "cognitive"],
    ["nesting", "Nesting depth", "nesting"],
    ["errors", "Error paths", "errorPaths"],
  ] as const) {
    for (const delta of signals[kind]) {
      const functions = byFile.get(delta.path) ?? new Map<FunctionDelta, string[]>();
      functions.set(delta, [...(functions.get(delta) ?? []), metricSentence(delta, metric, label)]);
      byFile.set(delta.path, functions);
    }
  }
  for (const [file, functions] of byFile) {
    const candidates = [...functions].sort(([a], [b]) => importance(b) - importance(a)).slice(0, 5);
    ctx.finding({
      ruleId: "complexity.control-flow.increase",
      groupKey: `complexity.control-flow:${file}`,
      title: "Changed control flow became harder to follow",
      category: "maintainability",
      severity: "medium",
      confidence: "high",
      summary: candidates.length === 1
        ? `${candidates[0]![0].current.name} has a substantial control-flow increase in this change.`
        : `${candidates.length} changed functions in ${file} have related control-flow increases.`,
      whyItMatters: "Additional branches, nesting, and error paths make the changed behavior harder to review and maintain.",
      impact: "A future edit must account for more paths and active conditions in the affected functions.",
      evidence: candidates.map(([delta, reasons]) => functionEvidence(delta, reasons.join(" "))),
      recommendation: "Simplify the affected paths with guard clauses or a cohesive extraction where that preserves the behavior; keep error translation together when it spans the same operation.",
      remediation: { complexity: "medium" },
    });
  }
}

function emitStructuralClones(ctx: RuleContext, clones: Analysis["structuralClones"]): void {
  if (clones.length === 0) return;
  const selected = clones.slice(0, 4);
  ctx.finding({
    ruleId: "complexity.structural-clone.new",
    title: "New code repeats an existing multi-step operation",
    category: "design",
    severity: "low",
    confidence: "high",
    summary: selected.length === 1
      ? "A changed block copies an established same-file call sequence instead of reusing its implementation."
      : `${selected.length} changed blocks copy established same-file call sequences.`,
    whyItMatters: "Two copies of the same multi-step operation can drift in ordering, error handling, or resource lifecycle when either path changes later.",
    impact: "Maintenance now requires keeping parallel implementations synchronized even though the operation already had a reusable home.",
    evidence: selected.flatMap((clone) => [{
      location: { file: clone.path, line: clone.changed.line, endLine: clone.changed.endLine },
      label: "New copy",
      message: `This changed span repeats ${clone.calls.length} calls from the existing operation: ${clone.calls.join(" → ")}.`,
      data: { calls: clone.calls, role: "changed-copy" },
    }, {
      location: { file: clone.path, line: clone.existing.line, endLine: clone.existing.endLine },
      label: "Existing operation",
      message: "The same normalized call sequence already existed here in the base revision.",
      data: { calls: clone.calls, role: "existing-operation" },
    }]),
    recommendation: "Reuse or parameterize the existing operation when the ordering, side effects, and failure behavior are intended to stay aligned; otherwise make the semantic difference explicit.",
    remediation: { complexity: "small" },
  });
}

function emitTrivialWrappers(ctx: RuleContext, design: DesignSignals): void {
  if (design.trivialWrappers.length === 0) return;
  const wrappers = design.trivialWrappers.slice(0, 5);
  ctx.finding({
    ruleId: "complexity.wrapper.trivial",
    title: "One-use layout wrappers add indirection without behavior",
    category: "design",
    severity: "low",
    confidence: "medium",
    summary: wrappers.length === 1
      ? `${wrappers[0]?.name} only delegates to one JSX element and has one visible call site.`
      : `${wrappers.length} new one-use components only delegate to a JSX element; the related indirection is grouped here.`,
    whyItMatters: "A name earns its navigation cost when it expresses a domain concept, owns behavior, or supports real reuse. A one-use layout delegate still requires readers to inspect both the wrapper and its call site.",
    impact: "The component surface grows without hiding meaningful behavior, making the layout harder to read and future changes more scattered.",
    evidence: wrappers.map((wrapper) => ({
      location: { file: wrapper.path, line: wrapper.line, endLine: wrapper.endLine },
      label: wrapper.name,
      message: `${wrapper.name} directly returns ${wrapper.target ?? "one JSX element"} and has one visible use in this file.`,
      data: { component: wrapper.name, target: wrapper.target, visibleUses: 1 },
    })),
    recommendation: "Inline the returned element at its only call site, unless this component is intended to own behavior, semantics, or demonstrated reuse that is not visible in the change.",
    remediation: { complexity: "small" },
  });
}

function emitMetricFinding(
  ctx: RuleContext,
  input: {
    ruleId: string;
    title: string;
    category: string;
    candidates: Candidate[];
    why: string;
    recommendation: string;
    confidence?: "medium" | "high";
  },
): void {
  if (input.candidates.length === 0) return;
  const candidates = input.candidates
    .sort((a, b) => importance(b.delta) - importance(a.delta))
    .slice(0, 5);
  ctx.finding({
    ruleId: input.ruleId,
    title: input.title,
    category: input.category,
    severity: "medium",
    confidence: input.confidence ?? "high",
    summary:
      candidates.length === 1
        ? `${candidates[0]?.delta.current.name} shows a disproportionate increase in this change.`
        : `${candidates.length} changed functions show related complexity growth; the largest deltas are grouped here.`,
    whyItMatters: input.why,
    impact: "The implementation takes longer to review, is easier to change incorrectly, and makes the underlying behavior less visible.",
    evidence: candidates.map((candidate) => functionEvidence(candidate.delta, candidate.reason)),
    recommendation: input.recommendation,
    remediation: { complexity: "medium" },
  });
}

function emitPrematureAbstraction(ctx: RuleContext, design: DesignSignals): void {
  if (design.premature.length < 2) return;
  ctx.finding({
    ruleId: "complexity.abstraction.premature",
    title: "New abstractions have little demonstrated variation",
    category: "design",
    severity: "low",
    confidence: "medium",
    summary: "The change introduces abstraction points that currently have one implementation, one constructed type, or one use.",
    whyItMatters: "An abstraction that does not yet separate real variation adds concepts and navigation cost without reducing change coupling.",
    impact: "Future maintainers must understand both the abstraction and implementation even though the code currently has only one behavior.",
    evidence: design.premature.slice(0, 5).map((signal) => ({
      location: { file: signal.path, line: signal.line },
      message: `${signal.kind} ${signal.name}: ${signal.detail}`,
      data: { kind: signal.kind, name: signal.name, detail: signal.detail },
    })),
    recommendation: "Keep abstractions that isolate a real boundary or likely near-term variation; otherwise use the concrete concept until a second use clarifies the interface.",
    remediation: { complexity: "small" },
  });
}

function emitIndirection(ctx: RuleContext, design: DesignSignals): void {
  if (design.chain === undefined) return;
  ctx.finding({
    ruleId: "complexity.indirection",
    title: "A simple operation crosses too many forwarding layers",
    category: "design",
    severity: "medium",
    confidence: "medium",
    summary: `The changed call path passes through ${design.chain.names.length} mostly forwarding functions.`,
    whyItMatters: "Indirection is useful when a layer owns policy or substitution; forwarding-only layers make behavior harder to locate without adding a boundary.",
    impact: "Understanding or debugging one operation requires navigating several files or functions that do not make an independent decision.",
    evidence: [{
      location: { file: design.chain.path, line: design.chain.line },
      message: design.chain.names.join(" → "),
      data: { depth: design.chain.names.length, chain: design.chain.names },
    }],
    recommendation: "Collapse forwarding-only layers while preserving layers that own policy, lifecycle, or a genuine substitution boundary.",
    remediation: { complexity: "medium" },
  });
}

function emitOverengineering(
  ctx: RuleContext,
  analysis: Analysis,
  design: DesignSignals,
  growth: FunctionDelta[],
  responsibilities: FunctionDelta[],
): void {
  const evidence = [
    ...design.premature.slice(0, 2).map((signal) => ({
      location: { file: signal.path, line: signal.line },
      message: `${signal.kind} ${signal.name}: ${signal.detail}`,
      data: { signal: "low-variation-abstraction", detail: signal.detail },
    })),
    ...(design.chain === undefined ? [] : [{
      location: { file: design.chain.path, line: design.chain.line },
      message: `Forwarding chain: ${design.chain.names.join(" → ")}`,
      data: { signal: "indirection", depth: design.chain.names.length },
    }]),
    ...growth.slice(0, 1).map((delta) => functionEvidence(delta, `${metricSentence(delta, "loc", "LOC")} Branches: ${before(delta, "branches")} → ${delta.current.branches}.`)),
    ...responsibilities.slice(0, 1).map((delta) => functionEvidence(delta, `Now combines ${list(delta.current.responsibilities)}.`)),
  ].slice(0, 5);
  ctx.finding({
    ruleId: "complexity.ai-overengineering",
    title: "The implementation appears more architectural than the behavior requires",
    category: "design",
    severity: "medium",
    confidence: "medium",
    summary: "The change combines several AI-overengineering signals: low-variation abstractions, forwarding layers, and concentrated control-flow growth.",
    whyItMatters: "Fighting a modest problem with additional architecture moves complexity rather than removing it, leaving more concepts, paths, and extension points to maintain.",
    impact: "The code becomes noticeably harder to understand and modify even though the visible behavior and test surface have not expanded proportionally.",
    evidence,
    recommendation: "Start from the direct implementation, retain only boundaries that own real policy or variation, and make the primary behavior readable from one place.",
    remediation: { complexity: "architectural" },
    metadata: {
      changedSourceFiles: analysis.changedSourceFiles,
      changedTestFiles: analysis.changedTestFiles,
      wrapperGrowth: design.wrapperGrowth,
    },
  });
}

function designSignals(analysis: Analysis, complexityPressure: number): DesignSignals {
  const previousByPath = new Map(analysis.previous.map((file) => [file.path, file]));
  const premature: DesignSignals["premature"] = [];
  const trivialWrappers: DesignSignals["trivialWrappers"] = [];
  let wrapperGrowth = 0;
  let bestChain: DesignSignals["chain"];

  for (const file of analysis.current) {
    const revision = analysis.files.find((item) => item.path === file.path);
    const old = previousByPath.get(file.path);
    const oldInterfaces = new Set(old?.abstractions.interfaces.map((item) => item.name) ?? []);
    const oldFactories = new Set(old?.abstractions.factories.map((item) => item.name) ?? []);
    const oldGenerics = new Set(old?.abstractions.genericDeclarations.map((item) => item.name) ?? []);
    const changed = (line: number, endLine = line) => revision?.status !== "modified" || intersects(revision.changedLines, line, endLine);

    for (const item of file.abstractions.interfaces) {
      if (!oldInterfaces.has(item.name) && changed(item.line) && item.implementations <= 1) {
        premature.push({ path: file.path, line: item.line, kind: "Interface", name: item.name, detail: `${item.implementations} concrete implementation${item.implementations === 1 ? "" : "s"}` });
      }
    }
    for (const item of file.abstractions.factories) {
      if (!oldFactories.has(item.name) && changed(item.line) && item.constructedTypes.length === 1) {
        premature.push({ path: file.path, line: item.line, kind: "Factory", name: item.name, detail: `constructs only ${item.constructedTypes[0]}` });
      }
    }
    for (const item of file.abstractions.genericDeclarations) {
      if (!oldGenerics.has(item.name) && changed(item.line) && item.references <= 1) {
        premature.push({ path: file.path, line: item.line, kind: "Generic", name: item.name, detail: `${item.parameters} type parameter${item.parameters === 1 ? "" : "s"}, ${item.references} external reference${item.references === 1 ? "" : "s"}` });
      }
    }

    if (analysis.mode === "diff") {
      const oldWrappersByName = new Map(old?.abstractions.wrappers.map((item) => [item.name, item]) ?? []);
      for (const item of file.abstractions.wrappers) {
        if (item.kind !== "jsx" || !/^[A-Z]/.test(item.name) || item.references !== 1 || !changed(item.line, item.endLine)) continue;
        const previous = oldWrappersByName.get(item.name);
        if (previous?.kind === "jsx" && previous.references === 1) continue;
        trivialWrappers.push({ path: file.path, line: item.line, endLine: item.endLine, name: item.name, target: item.target });
      }
    }

    const oldWrappers = old?.abstractions.wrappers.length ?? 0;
    wrapperGrowth += Math.max(0, file.abstractions.wrappers.length - oldWrappers);
    const chain = longestWrapperChain(file);
    if (chain !== undefined && chain.names.length >= 4 && (bestChain === undefined || chain.names.length > bestChain.names.length)) {
      bestChain = chain;
    }
  }

  return { premature, trivialWrappers, wrapperGrowth, chain: bestChain, complexityPressure };
}

function intersects(lines: Set<number>, start: number, end: number): boolean {
  for (const line of lines) if (line >= start && line <= end) return true;
  return false;
}

function longestWrapperChain(file: FileMetrics): DesignSignals["chain"] {
  const wrappers = new Map(file.abstractions.wrappers.map((item) => [item.name, item]));
  let best: string[] = [];
  let bestLine = 1;
  for (const wrapper of wrappers.values()) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: typeof wrapper | undefined = wrapper;
    while (current !== undefined && !seen.has(current.name)) {
      chain.push(current.name);
      seen.add(current.name);
      const target: string | undefined = current.target?.split(".").pop();
      current = target === undefined ? undefined : wrappers.get(target);
    }
    if (chain.length > best.length) {
      best = chain;
      bestLine = wrapper.line;
    }
  }
  return best.length === 0 ? undefined : { path: file.path, names: best, line: bestLine };
}

function overengineeringScore(
  analysis: Analysis,
  design: DesignSignals,
  growth: FunctionDelta[],
  responsibilities: FunctionDelta[],
): number {
  let score = 0;
  if (design.premature.length >= 2) score += 2;
  if (design.wrapperGrowth >= 3) score += 2;
  if (design.chain !== undefined) score += 2;
  if (design.complexityPressure >= 2) score += 1;
  if (growth.length > 0) score += 1;
  if (responsibilities.length > 0) score += 1;
  if (analysis.mode === "diff" && analysis.changedTestFiles === 0) score += 1;
  return score;
}

function addPositiveSignals(ctx: RuleContext, analysis: Analysis): void {
  if (analysis.mode !== "diff") return;
  const reduced = analysis.deltas.filter((delta) =>
    delta.previous !== undefined &&
    delta.current.cyclomatic <= delta.previous.cyclomatic - 3 &&
    delta.current.cognitive <= delta.previous.cognitive - 4,
  );
  if (reduced.length > 0) {
    ctx.review.positive({
      key: "complexity.reduced",
      summary: `${reduced.length} changed function${reduced.length === 1 ? " is" : "s are"} materially easier to reason about.`,
      evidence: reduced.slice(0, 3).map((delta) => functionEvidence(delta, `${metricSentence(delta, "cyclomatic", "Cyclomatic")} ${metricSentence(delta, "cognitive", "Cognitive")}`)),
    });
  }
  const flattened = analysis.deltas.filter((delta) => delta.previous !== undefined && delta.current.nesting <= delta.previous.nesting - 2);
  if (flattened.length > 0) {
    ctx.review.positive({
      key: "complexity.nesting.flattened",
      summary: `Nesting was flattened in ${flattened.length} changed function${flattened.length === 1 ? "" : "s"}.`,
      evidence: flattened.slice(0, 3).map((delta) => functionEvidence(delta, metricSentence(delta, "nesting", "Nesting depth"))),
    });
  }
}

function addOverallReview(
  ctx: RuleContext,
  analysis: Analysis,
  result: { materialFindings: number; aiOverengineering: boolean },
): void {
  if (analysis.mode === "repository") {
    ctx.review.assessment({
      risk: result.materialFindings > 0 ? "medium" : "none",
      summary: result.materialFindings > 0
        ? "The repository contains concentrated complexity worth simplifying, but no historical baseline was available to judge whether it was introduced recently."
        : "No disproportionate complexity was identified in the supported source files. No git delta was available, so this is a conservative repository-level assessment.",
    });
    ctx.review.opinion({
      ship: result.materialFindings === 0,
      summary: result.materialFindings > 0
        ? "I would simplify the highlighted implementation before extending it further."
        : "I would merge this as-is based on the available repository snapshot.",
    });
    return;
  }

  if (result.aiOverengineering || result.materialFindings >= 3) {
    ctx.review.assessment({
      risk: "medium",
      summary: "The implementation became noticeably more difficult to reason about because new behavior is spread across additional control flow, responsibilities, or abstraction layers.",
    });
    ctx.review.opinion({
      ship: false,
      summary: "I would simplify the implementation before merging. The complexity increase appears larger than the demonstrated behavior and test expansion require.",
    });
  } else if (result.materialFindings > 0) {
    ctx.review.assessment({
      risk: "low",
      summary: "The change adds localized complexity. Most of the implementation remains understandable, but the highlighted area deserves another simplification pass.",
    });
    ctx.review.opinion({
      ship: true,
      summary: "I would merge this after considering the focused simplification; the added complexity is not broadly architectural.",
    });
  } else {
    const easier = analysis.deltas.some((delta) => delta.previous !== undefined && delta.current.cognitive < delta.previous.cognitive);
    ctx.review.assessment({
      risk: "none",
      summary: easier
        ? "The changed implementation became easier to follow overall, and no disproportionate complexity growth was identified."
        : "The added complexity appears proportional to the changed behavior; no disproportionate growth was identified.",
    });
    ctx.review.opinion({ ship: true, summary: "I would merge this PR. The implementation remains proportionate to the behavior being added." });
  }
}

function isCyclomaticIncrease(delta: FunctionDelta): boolean {
  const previous = delta.previous?.cyclomatic ?? 0;
  if (delta.previous === undefined) return delta.current.cyclomatic >= 12;
  const increase = delta.current.cyclomatic - previous;
  return delta.current.cyclomatic >= 8 && increase >= 5 && (increase >= 7 || delta.current.cyclomatic / Math.max(previous, 1) >= 1.4);
}

function isCognitiveIncrease(delta: FunctionDelta): boolean {
  const previous = delta.previous?.cognitive ?? 0;
  if (delta.previous === undefined) return delta.current.cognitive >= 18;
  const increase = delta.current.cognitive - previous;
  return delta.current.cognitive >= 12 && increase >= 8 && (increase >= 10 || delta.current.cognitive / Math.max(previous, 1) >= 1.5);
}

function isLargeGrowth(delta: FunctionDelta): boolean {
  const previousLoc = delta.previous?.loc ?? 0;
  const locDelta = delta.current.loc - previousLoc;
  const branchIncrease = branchDelta(delta);
  if (delta.previous === undefined) return delta.current.loc >= 100 && delta.current.branches >= 8;
  return locDelta >= 40 && branchIncrease >= 3 && (locDelta >= 80 || delta.current.loc / Math.max(previousLoc, 1) >= 1.6);
}

function isResponsibilityExpansion(delta: FunctionDelta): boolean {
  const previous = new Set(delta.previous?.responsibilities ?? []);
  const additions = delta.current.responsibilities.filter((item) => !previous.has(item)).length;
  if (delta.previous === undefined) return delta.current.responsibilities.length >= 5 && delta.current.loc >= 60;
  return delta.current.responsibilities.length >= 4 && additions >= 2;
}

function isRecursionRisk(delta: FunctionDelta): boolean {
  const previous = delta.previous?.recursiveCalls ?? 0;
  if (delta.previous === undefined) return delta.current.recursiveCalls >= 2;
  return delta.current.recursiveCalls >= 2 && delta.current.recursiveCalls > previous;
}

function increased(
  delta: FunctionDelta,
  key: NumericMetric,
  minimumDelta: number,
  minimumCurrent: number,
  minimumAdded: number,
): boolean {
  const previous = delta.previous?.[key] ?? 0;
  return delta.previous === undefined
    ? delta.current[key] >= minimumAdded
    : delta.current[key] >= minimumCurrent && delta.current[key] - previous >= minimumDelta;
}

type NumericMetric = {
  [K in keyof FunctionMetrics]-?: FunctionMetrics[K] extends number ? K : never;
}[keyof FunctionMetrics];

function metricSentence(delta: FunctionDelta, key: NumericMetric, label: string): string {
  const oldValue = delta.previous?.[key] ?? 0;
  const current = delta.current[key];
  return `${label}: ${oldValue} → ${current} (Δ +${current - oldValue}).`;
}

function before(delta: FunctionDelta, key: NumericMetric): number {
  return delta.previous?.[key] ?? 0;
}

function branchDelta(delta: FunctionDelta): number {
  return delta.current.branches - (delta.previous?.branches ?? 0);
}

function importance(delta: FunctionDelta): number {
  return (
    delta.current.cognitive - (delta.previous?.cognitive ?? 0) +
    delta.current.cyclomatic - (delta.previous?.cyclomatic ?? 0) +
    delta.current.nesting * 2
  );
}

function functionEvidence(delta: FunctionDelta, message: string) {
  return {
    location: { file: delta.path, line: delta.anchorLine },
    label: delta.current.name,
    message,
    data: {
      function: delta.current.name,
      functionStartLine: delta.current.line,
      functionEndLine: delta.current.endLine,
      previous: metricSnapshot(delta.previous),
      current: metricSnapshot(delta.current),
      delta: {
        cyclomatic: delta.current.cyclomatic - (delta.previous?.cyclomatic ?? 0),
        cognitive: delta.current.cognitive - (delta.previous?.cognitive ?? 0),
        nesting: delta.current.nesting - (delta.previous?.nesting ?? 0),
        loc: delta.current.loc - (delta.previous?.loc ?? 0),
        parameters: delta.current.parameters - (delta.previous?.parameters ?? 0),
      },
    },
  };
}

function metricSnapshot(metrics?: FunctionMetrics): Record<string, unknown> | null {
  if (metrics === undefined) return null;
  return {
    cyclomatic: metrics.cyclomatic,
    cognitive: metrics.cognitive,
    nesting: metrics.nesting,
    loc: metrics.loc,
    parameters: metrics.parameters,
    branches: metrics.branches,
  };
}

function list(items: string[]): string {
  return items.join(", ");
}
