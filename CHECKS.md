# Checks

| Rule | Severity | Scans for |
| --- | --- | --- |
| `complexity.abstraction.premature` | Review | New interfaces, factories, or generics with little demonstrated variation |
| `complexity.ai-overengineering` | Review | Synthesized architecture, indirection, and complexity signals |
| `complexity.branch-without-tests` | Review | Material decision growth without changed tests |
| `complexity.configuration-explosion` | Review | Rapid growth in configuration fields consumed by a function |
| `complexity.control-flow.increase` | Review | Related cyclomatic, cognitive, nesting, and error-path growth combined by file and anchored to changed statements |
| `complexity.hidden-state` | Review | Growth in mutable module, instance, global, or cache state |
| `complexity.indirection` | Review | Long forwarding-only call chains |
| `complexity.large-function-growth` | Review | Disproportionate relative and absolute function growth |
| `complexity.magic-conditions` | Review | Rapidly expanding boolean expressions |
| `complexity.nesting.flattened` | Review | Flattened nesting / early-return refactors |
| `complexity.parameter-growth` | Review | Expanding parameter lists |
| `complexity.recursion-risk` | Review | Multiple or expanding recursive paths |
| `complexity.reduced` | Review | Material reduction in both cyclomatic and cognitive complexity |
| `complexity.responsibility-expansion` | Review | Parsing, validation, orchestration, persistence, and formatting accumulating together |
| `complexity.structural-clone.new` | Review | A changed Python, Rust, JavaScript, or TypeScript block growing one established same-file multi-step call sequence into two copies |
| `complexity.wrapper.trivial` | Review | New one-use JSX layout wrappers with no behavior or semantics |
