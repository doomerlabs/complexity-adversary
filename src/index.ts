#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Adversary } from "@adversarylabs/sdk";
import { analyzeDiscovery } from "./analyze.js";
import { discoverSources } from "./discover.js";
import { reviewComplexity } from "./rules.js";

export function createApp(): Adversary {
  const app = new Adversary({
    name: "review/complexity",
    version: "0.0.16",
    review: { maximumFindings: 6, minimumConfidence: "medium" },
  });

  app.rule("complexity.review", async (ctx) => {
    const discovery = await discoverSources(ctx);
    const analysis = analyzeDiscovery(discovery);
    ctx.summary.files_scanned = discovery.files.length;
    ctx.review.observe({
      key: "complexity.analysis-mode",
      summary:
        analysis.mode === "diff"
          ? `Compared ${analysis.files.length} changed source files against ${analysis.base ?? "the supplied baseline"}.`
          : `Reviewed ${analysis.files.length} source files conservatively without a git baseline.`,
      metadata: {
        mode: analysis.mode,
        base: analysis.base,
        metricLanguages: ["JavaScript", "TypeScript"],
        structuralCloneLanguages: ["JavaScript", "TypeScript", "Python", "Rust"],
      },
    });
    reviewComplexity(ctx, analysis);
  });

  return app;
}

async function runIfDirect(): Promise<void> {
  if (
    process.argv[1] !== undefined &&
    (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
  ) {
    await createApp().runFromEnvironment();
  }
}

void runIfDirect();
