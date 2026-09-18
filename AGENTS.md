# AGENTS.md

## Purpose

This repository contains the Complexity adversary. It reviews code changes for implementation complexity that appears disproportionate to the behavior being added.

## Design principles

- Prefer complexity deltas over absolute thresholds.
- Use established analyzers for named metrics; do not invent cyclomatic or cognitive complexity calculations.
- Keep deterministic metrics separate from architectural heuristics.
- Point every finding to changed code and include concrete before/after evidence.
- Prefer one synthesized finding over many small observations.
- Keep medium-confidence design advice non-dogmatic.
- Never modify the scanned repository.

## Testing

- Add a regression fixture for every new signal.
- Test both noisy and justified complexity growth.
- Test repository-only behavior separately from diff-aware behavior.
- Run `npm test` and `doomer validate .` before release.
