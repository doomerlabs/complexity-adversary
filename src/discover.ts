import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import { type RuleContext } from "@adversarylabs/sdk";
import { SOURCE_EXTENSIONS, type SourceRevision } from "./types.js";

const execute = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "vendor",
]);
const MAX_FILES = 500;

export interface Discovery {
  mode: "diff" | "repository";
  base?: string;
  files: SourceRevision[];
  changedTestFiles: number;
  changedSourceFiles: number;
}

export async function discoverSources(ctx: RuleContext): Promise<Discovery> {
  const repoPath = ctx.repoPath;
  const sources = await ctx.loadInScopeSources({ include: isSourcePath, limit: MAX_FILES });
  if (ctx.change === null || ctx.change.scanMode === "all") {
    return snapshotDiscovery(sources);
  }

  const base = ctx.change.baseRef;
  if (base === undefined || !await revisionExists(repoPath, base)) {
    return snapshotDiscovery(sources);
  }

  const files: SourceRevision[] = [];
  for (const source of sources) {
    files.push(await sourceRevision(ctx, base, source));
  }

  return {
    mode: "diff",
    ...(ctx.change.baseRef === undefined ? {} : { base: ctx.change.baseRef }),
    files,
    changedTestFiles: ctx.change.changedFiles.filter((path) => isSourcePath(path) && isTestPath(path)).length,
    changedSourceFiles: files.filter((file) => !isTestPath(file.path)).length,
  };
}

function snapshotDiscovery(sources: Array<{ path: string; content: string }>): Discovery {
  return {
    mode: "repository",
    files: sources.map((source) => ({
      path: source.path,
      current: source.content,
      changedLines: new Set<number>(),
      status: "repository",
    })),
    changedTestFiles: 0,
    changedSourceFiles: sources.length,
  };
}

async function sourceRevision(ctx: RuleContext, base: string, source: { path: string; content: string }): Promise<SourceRevision> {
  if (!await existsAtRevision(ctx.repoPath, base, source.path)) {
    return {
      path: source.path,
      current: source.content,
      changedLines: new Set<number>(),
      status: "added",
    };
  }
  return {
    path: source.path,
    current: source.content,
    previous: await gitShow(ctx.repoPath, base, source.path),
    changedLines: await changedLineNumbers(ctx, source.path),
    status: "modified",
  };
}

async function revisionExists(repoPath: string, revision: string): Promise<boolean> {
  try {
    await execute("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

async function changedLineNumbers(ctx: RuleContext, path: string): Promise<Set<number>> {
  const base = ctx.change?.baseRef;
  if (base === undefined) return new Set<number>();
  const args = ["diff", "--unified=0", base];
  const head = ctx.change?.headRef;
  if (head !== undefined && !ctx.change?.worktree) args.push(head);
  args.push("--", path);
  const patch = await gitOutput(ctx.repoPath, args);
  const lines = new Set<number>();
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = Math.max(1, match[2] === undefined ? 1 : Number(match[2]));
    for (let line = start; line < start + count; line += 1) lines.add(line);
  }
  return lines;
}

async function gitShow(repoPath: string, revision: string, path: string): Promise<string> {
  return gitOutput(repoPath, ["show", `${revision}:${path}`]);
}

async function existsAtRevision(repoPath: string, revision: string, path: string): Promise<boolean> {
  const paths = await gitOutput(repoPath, ["ls-tree", "-z", "--name-only", revision, "--", path]);
  return paths.split("\0").includes(path);
}

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function isSourcePath(path: string): boolean {
  if (!SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  const parts = path.split("/");
  if (parts.some((part) => IGNORED_DIRECTORIES.has(part))) return false;
  return !/\.(?:min|bundle|generated)\.[cm]?[jt]sx?$/i.test(path);
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(?:test|tests|__tests__|spec)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}
