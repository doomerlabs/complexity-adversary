import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { analyzeFile } from "../src/analyze.ts";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);

async function repository(before: string, after: string, testChange?: string, sourceFile = "service.ts"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "complexity-repo-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", sourceFile), before);
  await execute("git", ["init", "-q"], { cwd: root });
  await execute("git", ["config", "user.email", "complexity@example.test"], { cwd: root });
  await execute("git", ["config", "user.name", "Complexity Tests"], { cwd: root });
  await execute("git", ["add", "."], { cwd: root });
  await execute("git", ["commit", "-qm", "baseline"], { cwd: root });
  await writeFile(join(root, "src", sourceFile), after);
  if (testChange !== undefined) {
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(join(root, "test", "service.test.ts"), testChange);
  }
  return root;
}

async function review(root: string) {
  try {
    await execute("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      execute("git", ["diff", "--name-only", "HEAD", "--"], { cwd: root }),
      execute("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root }),
    ]);
    const changedFiles = [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean))];
    return reviewChanged(root, changedFiles);
  } catch {
    return createApp().run({ input: { source: { path: root } }, includeRawObservations: true });
  }
}

async function reviewChanged(root: string, changedFiles: string[]) {
  return createApp().run({
    input: {
      source: { path: root },
      change: {
        type: "diff",
        base_ref: "HEAD",
        head_ref: "WORKTREE",
        scan_mode: "changed",
        changed_files: changedFiles,
      },
    },
    includeRawObservations: true,
  });
}

const SIMPLE = `export function reconcile(input: { ready: boolean; value: number }) {
  if (!input.ready) return 0;
  return input.value;
}
`;

const COMPLEX = `export function reconcile(input: {
  ready: boolean;
  value: number;
  mode: string;
  retries: number;
  items: number[];
}) {
  if (!input.ready) return 0;
  let result = input.value;
  if (input.mode === "batch") {
    for (const item of input.items) {
      if (item > 100) {
        if (input.retries > 2) {
          result += item;
        } else if (item % 2 === 0) {
          result -= item;
        } else {
          result += 1;
        }
      }
    }
  } else if (input.mode === "single") {
    result += 1;
  } else if (input.mode === "dry-run") {
    result = 0;
  }
  switch (input.mode) {
    case "safe": result = Math.max(0, result); break;
    case "fast": result *= 2; break;
    case "debug": result += input.items.length; break;
    default: result = Math.min(result, 1000);
  }
  try {
    if (result < 0) throw new Error("negative");
  } catch {
    result = 0;
  }
  return result;
}
`;

test("uses established cyclomatic and cognitive analyzers", () => {
  const metrics = analyzeFile("service.ts", COMPLEX).functions[0];
  assert.ok(metrics);
  assert.ok(metrics.cyclomatic >= 12, `cyclomatic was ${metrics.cyclomatic}`);
  assert.ok(metrics.cognitive >= 18, `cognitive was ${metrics.cognitive}`);
  assert.ok(metrics.nesting >= 4, `nesting was ${metrics.nesting}`);
});

test("reports meaningful complexity deltas with concrete before and after metrics", async () => {
  const output = await review(await repository(SIMPLE, COMPLEX));
  const ids = output.findings.map((finding) => finding.ruleId);
  assert.equal(ids.filter((id) => id === "complexity.control-flow.increase").length, 1);
  const evidence = output.findings.find((finding) => finding.ruleId === "complexity.control-flow.increase")?.evidence[0];
  assert.equal(evidence?.location?.file, "src/service.ts");
  assert.equal(evidence?.data?.function, "reconcile");
  assert.equal(evidence?.location?.endLine, undefined);
  assert.ok(Number(evidence?.location?.line) > 1);
  assert.deepEqual((evidence?.data?.previous as Record<string, unknown>)?.cyclomatic, 2);
  assert.ok(Number((evidence?.data?.current as Record<string, unknown>)?.cyclomatic) >= 12);
});

test("combines related control-flow signals and anchors changed statements", async () => {
  const before = `${SIMPLE}\nexport function load(value: number) { return value; }\n`;
  const after = `${COMPLEX}\nexport function load(value: number) {
  try {
    if (value < 0) throw new Error('negative');
    if (value === 0) throw new Error('zero');
    return value;
  } catch (error) {
    if (value === 0) throw error;
    throw new Error('load failed', { cause: error });
  } finally {
    cleanup();
  }
}\n`;
  const output = await review(await repository(before, after, "// changed tests\n"));
  const findings = output.findings.filter((finding) => finding.ruleId === "complexity.control-flow.increase");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.evidence.length, 2);
  for (const evidence of findings[0]!.evidence) {
    const line = evidence.location?.line;
    assert.equal(evidence.location?.endLine, undefined);
    assert.ok(line && /^(?:\s*|\s*}\s*)(?:if|try|catch|throw)\b/.test(after.split("\n")[line - 1] ?? ""));
    assert.ok(Number(evidence.data?.functionEndLine) > line);
  }
});

test("uses the runner-supplied changed files instead of re-deriving repository scope", async () => {
  const root = await repository(SIMPLE, COMPLEX);
  await writeFile(join(root, "src", "other.ts"), "export const answer = 42;\n");

  const output = await reviewChanged(root, ["src/other.ts"]);
  assert.equal(output.target.filesScanned, 1);
  assert.equal(output.findings.some((finding) =>
    finding.evidence.some((evidence) => evidence.location?.file === "src/service.ts")), false);
});

test("ignores small low-baseline increases", async () => {
  const slightlyLarger = `export function reconcile(input: { ready: boolean; value: number; enabled: boolean }) {
  if (!input.ready) return 0;
  if (!input.enabled) return input.value;
  return input.value + 1;
}
`;
  const output = await review(await repository(SIMPLE, slightlyLarger, "// existing coverage remains representative\n"));
  assert.equal(output.findings.some((finding) => finding.ruleId === "complexity.control-flow.increase"), false);
  assert.equal(output.opinion?.ship, true);
});

test("reports branch growth when tests do not change", async () => {
  const output = await review(await repository(SIMPLE, COMPLEX));
  const finding = output.findings.find((item) => item.ruleId === "complexity.branch-without-tests");
  assert.ok(finding);
  assert.match(finding.summary, /does not modify tests/i);
});

test("does not call a new 38-line file complexity growth from zero", async () => {
  const root = await repository(SIMPLE, SIMPLE);
  const body = Array.from({ length: 17 }, (_, index) =>
    `  if (value === ${index}) return ${index};`).join("\n");
  const newFile = `export function classify(value: number) {
${body}
  return -1;
}
${"\n".repeat(17)}`;
  assert.equal(newFile.split("\n").length, 38);
  await writeFile(join(root, "src", "classifier.ts"), newFile);

  const output = await review(root);
  assert.deepEqual(output.findings, []);
  assert.equal(output.opinion?.ship, true);
});

test("still reports concrete overengineering in a new file", async () => {
  const root = await repository(SIMPLE, SIMPLE);
  const overbuilt = `interface Runner { run(value: number): number }
class DefaultRunner implements Runner { run(value: number) { return value + 1; } }
function createRunner(): Runner { return new DefaultRunner(); }
function implementation(value: number) { return createRunner().run(value); }
function executor(value: number) { return implementation(value); }
function strategy(value: number) { return executor(value); }
function resolver(value: number) { return strategy(value); }
function manager(value: number) { return resolver(value); }
export function controller(value: number) { return manager(value); }
`;
  await writeFile(join(root, "src", "overbuilt.ts"), overbuilt);

  const output = await review(root);
  assert.ok(output.findings.some((finding) => finding.ruleId === "complexity.ai-overengineering"));
  assert.equal(output.findings.some((finding) => finding.ruleId === "complexity.control-flow.increase"), false);
});

test("recognizes substantial simplification", async () => {
  const output = await review(await repository(COMPLEX, SIMPLE, "// simplified-path coverage\n"));
  assert.equal(output.findings.some((finding) => finding.ruleId?.includes("increase")), false);
  assert.ok(output.positives.some((positive) => positive.key === "complexity.reduced"));
  assert.ok(output.positives.some((positive) => positive.key === "complexity.nesting.flattened"));
  assert.match(output.assessment?.summary ?? "", /easier to follow/i);
});

test("treats low-variation abstractions as medium-confidence design advice", async () => {
  const abstracted = `interface Clock { now(): number }
class SystemClock implements Clock { now() { return Date.now(); } }
function createClock(): Clock { return new SystemClock(); }
export function timestamp() { return createClock().now(); }
`;
  const output = await review(await repository("export function timestamp() { return Date.now(); }\n", abstracted, "// timestamp test\n"));
  const finding = output.findings.find((item) => item.ruleId === "complexity.abstraction.premature");
  assert.ok(finding);
  assert.equal(finding.confidence, "medium");
  assert.match(JSON.stringify(finding.evidence), /Interface|Factory/);
});

test("detects excessive forwarding indirection", async () => {
  const indirect = `function implementation(value: number) { return value + 1; }
function executor(value: number) { return implementation(value); }
function strategy(value: number) { return executor(value); }
function resolver(value: number) { return strategy(value); }
function manager(value: number) { return resolver(value); }
export function controller(value: number) { return manager(value); }
`;
  const output = await review(await repository("export function controller(value: number) { return value + 1; }\n", indirect, "// controller test\n"));
  const finding = output.findings.find((item) => item.ruleId === "complexity.indirection");
  assert.ok(finding);
  assert.match(JSON.stringify(finding.evidence), /controller|manager|resolver|strategy/);
});

test("flags exported one-use JSX layout wrappers", async () => {
  const before = `type Props = { children: React.ReactNode };
export function AvatarEditor() { return <Flex margin="md"><Cropper /></Flex>; }
`;
  const after = `type Props = { children: React.ReactNode };
export function CropperContainer({children}: Props) {
  return <Flex margin="md">{children}</Flex>;
}
export function AvatarEditor() {
  return <CropperContainer><Cropper /></CropperContainer>;
}
`;
  const output = await review(await repository(before, after, undefined, "service.tsx"));
  const finding = output.findings.find((item) => item.ruleId === "complexity.wrapper.trivial");
  assert.ok(finding);
  assert.match(JSON.stringify(finding.evidence), /CropperContainer|Flex/);
});

test("groups multiple trivial JSX wrappers into one finding", async () => {
  const after = `type Props = { children: React.ReactNode };
function FirstLayout({children}: Props) { return <Flex margin="md">{children}</Flex>; }
function SecondLayout({children}: Props) { return <Stack gap="sm">{children}</Stack>; }
export function Screen() {
  return <><FirstLayout><One /></FirstLayout><SecondLayout><Two /></SecondLayout></>;
}
`;
  const output = await review(await repository("export function Screen() { return <><One /><Two /></>; }\n", after, undefined, "service.tsx"));
  const findings = output.findings.filter((item) => item.ruleId === "complexity.wrapper.trivial");
  assert.equal(findings.length, 1);
  assert.match(JSON.stringify(findings[0]?.evidence), /FirstLayout/);
  assert.match(JSON.stringify(findings[0]?.evidence), /SecondLayout/);
});

test("keeps reused and behavior-owning JSX wrappers quiet", async () => {
  const reused = `type Props = { children: React.ReactNode };
function SharedLayout({children}: Props) { return <Flex margin="md">{children}</Flex>; }
export function First() { return <SharedLayout><One /></SharedLayout>; }
export function Second() { return <SharedLayout><Two /></SharedLayout>; }
`;
  const behavioral = `type Props = { children: React.ReactNode };
function AccessibleCropper({children}: Props) {
  return <Flex role="group" onKeyDown={handleCropperKeys}>{children}</Flex>;
}
export function AvatarEditor() { return <AccessibleCropper><Cropper /></AccessibleCropper>; }
`;
  const transformed = `type Props = { children: React.ReactNode, margin: number };
function ComputedLayout({children, margin}: Props) {
  return <Flex {...layoutProps} margin={margin + 1}>{children}</Flex>;
}
export function AvatarEditor() { return <ComputedLayout margin={2}><Cropper /></ComputedLayout>; }
`;
  const baseline = "export function AvatarEditor() { return <Cropper />; }\n";
  for (const source of [reused, behavioral, transformed]) {
    const output = await review(await repository(baseline, source, undefined, "service.tsx"));
    assert.equal(output.findings.some((item) => item.ruleId === "complexity.wrapper.trivial"), false);
  }
});

test("synthesizes multiple architecture smells into the flagship rule", async () => {
  const overbuilt = `interface Runner { run(value: number): number }
class DefaultRunner implements Runner { run(value: number) { return value + 1; } }
function createRunner(): Runner { return new DefaultRunner(); }
function implementation(value: number) { return createRunner().run(value); }
function executor(value: number) { return implementation(value); }
function strategy(value: number) { return executor(value); }
function resolver(value: number) { return strategy(value); }
function manager(value: number) { return resolver(value); }
export function controller(value: number) { return manager(value); }
`;
  const output = await review(await repository("export function controller(value: number) { return value + 1; }\n", overbuilt));
  assert.ok(output.findings.some((item) => item.ruleId === "complexity.ai-overengineering"));
  assert.equal(output.findings.some((item) => item.ruleId === "complexity.indirection"), false);
  assert.equal(output.opinion?.ship, false);
});

test("covers the focused growth and state rules", async () => {
  const cases: Array<{ ruleId: string; before: string; after: string }> = [
    {
      ruleId: "complexity.parameter-growth",
      before: "export function configure(a: number, b: number, c: number, d: number) { return a + b + c + d; }\n",
      after: "export function configure(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) { return a + b + c + d + e + f + g + h; }\n",
    },
    {
      ruleId: "complexity.responsibility-expansion",
      before: "export function handle(value: string) { const parsed = parseInput(value); return validateInput(parsed); }\n",
      after: "export function handle(value: string) { const parsed = parseInput(value); validateInput(parsed); const result = executeJob(parsed); saveResult(result); return formatOutput(result); }\n",
    },
    {
      ruleId: "complexity.hidden-state",
      before: "let state = 0; let cache = 0; export function update() { state++; return state; }\n",
      after: "let state = 0; let cache = 0; export function update() { state++; cache++; state += cache; cache = state * 2; return state; }\n",
    },
    {
      ruleId: "complexity.magic-conditions",
      before: "export function allowed(a: boolean, b: boolean) { return a && b; }\n",
      after: "export function allowed(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean) { return a && (b || c) && (!d || e) && f; }\n",
    },
    {
      ruleId: "complexity.configuration-explosion",
      before: "export function configure(config: any) { return config.host + config.port + config.user; }\n",
      after: "export function configure(config: any) { return config.host + config.port + config.user + config.password + config.timeout + config.retries + config.region + config.pool + config.tls; }\n",
    },
    {
      ruleId: "complexity.recursion-risk",
      before: "export function walk(n: number): number { if (n <= 0) return 0; return walk(n - 1); }\n",
      after: "export function walk(n: number): number { if (n <= 0) return 0; return walk(n - 1) + walk(n - 2); }\n",
    },
    {
      ruleId: "complexity.control-flow.increase",
      before: "export function load(value: number) { if (value < 0) throw new Error('negative'); return value; }\n",
      after: "export function load(value: number) { try { if (value < 0) throw new Error('negative'); if (value === 0) throw new Error('zero'); return value; } catch (error) { if (value === 0) throw error; throw new Error('load failed', { cause: error }); } finally { cleanup(); } }\n",
    },
  ];

  for (const item of cases) {
    const output = await review(await repository(item.before, item.after, "// focused coverage\n"));
    assert.ok(
      output.findings.some((finding) => finding.ruleId === item.ruleId),
      `${item.ruleId} was not reported; got ${output.findings.map((finding) => finding.ruleId).join(", ")}`,
    );
  }
});

test("detects disproportionate large-function growth", async () => {
  const padding = Array.from({ length: 50 }, (_, index) => `  total += ${index};`).join("\n");
  const grown = `export function calculate(value: number) {
  let total = value;
  if (value > 0) total += 1;
  if (value > 10) total += 2;
  if (value > 100) total += 3;
${padding}
  return total;
}
`;
  const output = await review(await repository("export function calculate(value: number) { return value; }\n", grown, "// calculation tests\n"));
  assert.ok(output.findings.some((finding) => finding.ruleId === "complexity.large-function-growth"));
});

test("repository-only scans are conservative", async () => {
  const root = await mkdtemp(join(tmpdir(), "complexity-snapshot-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "service.ts"), SIMPLE);
  const output = await review(root);
  assert.deepEqual(output.findings, []);
  assert.equal(output.assessment?.risk, "none");
  assert.match(output.observations[0]?.summary ?? "", /without a git baseline/i);
});

test("repository-only scans do not infer that JSX wrappers are newly introduced", async () => {
  const root = await mkdtemp(join(tmpdir(), "complexity-snapshot-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "service.tsx"), `type Props = { children: React.ReactNode };
function Layout({children}: Props) { return <Flex margin="md">{children}</Flex>; }
export function Screen() { return <Layout><Content /></Layout>; }
`);
  const output = await review(root);
  assert.equal(output.findings.some((finding) => finding.ruleId === "complexity.wrapper.trivial"), false);
});

test("output is deterministic", async () => {
  const root = await repository(SIMPLE, COMPLEX);
  assert.deepEqual(await review(root), await review(root));
});
