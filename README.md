# Complexity adversary

Reviews code changes for implementation complexity that appears disproportionate to the behavior being added.

## Goals

The adversary is designed to produce a small number of high-confidence,
actionable findings grounded in concrete repository evidence. Its review should
be deterministic where possible, explicit about impact, and quiet when the
available evidence does not justify a finding.

## Scope

It evaluates changed JavaScript and TypeScript functions against their previous versions using established complexity metrics and structural design signals. A narrow cross-language signal also recognizes when changed Python or Rust code copies an established same-file multi-step operation instead of reusing it.

The complete detector or review inventory is maintained in
[CHECKS.md](CHECKS.md).

## Package and usage

- **Catalog reference:** `review/complexity`
- **Version:** `0.0.12`
- **Runtime:** Node.js 22
- **Repository:** https://github.com/doomerlabs/complexity-adversary

Run it against a local change with:

```sh
doomer run review/complexity --path /path/to/repository
```

This repository does not currently declare a project license. The published artifact retains the license files for its bundled third-party runtime dependencies.

## Boundaries

It judges complexity introduced by a change, not style, security, type safety, or unchanged legacy complexity. The clone signal requires the base revision to contain exactly one normalized occurrence and the change to introduce a second changed occurrence, so existing duplication, short idioms, comments, literals, generated code, and independently introduced symmetric implementations stay quiet.
