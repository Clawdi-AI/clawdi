# CLI Node Test Runner Upstream Evaluation

Status: completed evaluation evidence (2026-07-18)

## Outcome

This document records the upstream research and acceptance plan that preceded
the prototype. The prototype is complete, and
[ADR-0004](../adr/0004-keep-bun-for-cli-tests.md) accepts the measured outcome:
retain Bun 1.3.14 with serial file isolation for the CLI suite.

The pre-prototype recommendation was to evaluate **Vitest 4.1.10 on Node** with
its `forks` pool, file isolation, and one worker as the equivalence baseline.
The observed serial prototype did not clear the plan's gates: it discovered
976 rather than 1,011 tests, reported deterministic failures and pending tests,
and took about twice as long as the passing Bun baseline. The faster four-fork
run had the same incomplete and failing counts, so it was not a valid
comparison. ADR-0004 owns the detailed measurements and final decision; this
document retains the upstream rationale that selected and constrained the
prototype.

## Pinned facts

- The root manifest pins `packageManager: bun@1.3.14`; the installed executable
  reports `1.3.14`.
- `packages/cli/package.json` declares Node `>=22.5`, while the evaluation
  worktree currently runs Node `v24.18.0`. Results intended to prove the package
  floor must also run on Node 22.5 (or the oldest available 22.x image whose
  difference is explicitly recorded), not only Node 24.
- The npm registry reported Vitest `4.1.10` and
  `@vitest/coverage-v8` `4.1.10` as current stable versions on 2026-07-18.
  Both packages must be exact-versioned together for a reproducible prototype;
  Vitest's coverage guide describes the provider as an optional package.
- The CLI has 78 TypeScript test files importing `bun:test`. Their imports are
  limited to `describe`, `expect`, `it`/`test`, and the four lifecycle hooks.
  The suite uses `it.each`/`test.each`, but the search found no `mock.module`,
  Bun mock functions, fake-timer APIs, or snapshot matchers. Comments explicitly
  say module mocking was avoided because it bled across Bun test files.

The last item lowers the source migration risk: Vitest exposes the same common
surface. It does not eliminate runtime risk, because these tests exercise ESM,
child processes, environment variables, current working directory, filesystem
state, and process-global state.

## Upstream semantic comparison

### Existing Bun runner

Bun documents `bun test` as deeply integrated with the Bun runtime, which is
the source of its speed but also means it does not execute the published CLI on
its declared production runtime. Bun automatically defaults `NODE_ENV` to
`test`, `TZ` to UTC, and the test timeout to 5 seconds. It also states that an
unhandled rejection or error between tests makes the overall run fail. A Node
runner contract must set or test these assumptions rather than silently depend
on them. Bun's preload, loader, conditions, and env-file flags are Bun runtime
features; none is presently configured for the CLI suite.

Source: [Bun runtime behavior](https://bun.sh/docs/test/runtime-behavior).

Bun's migration guide describes `bun:test` as Jest-compatible, including mocks,
snapshots, lifecycle hooks, and fake timers, but compatibility claims are not an
equivalence proof for filesystem/process behavior.

Source: [Bun test runner](https://bun.sh/docs/test).

### Vitest

Vitest is the smallest first prototype because its common API includes the
suite's hooks, assertions, and parameterized tests, while actually executing
application modules in Node. That makes failures in Node ESM resolution,
Node filesystem/process semantics, and Node child-process integration visible
before publication.

Vitest 4 defaults to the `forks` pool. Its official pool documentation says
`threads` cannot use process APIs such as `process.chdir()`, while `forks` uses
child processes and supports them. The suite contains cwd-sensitive tests, so
`threads` is contractually wrong even if it benchmarks faster. The `vmThreads`
and `vmForks` modes are also rejected: Vitest warns that Node VM ESM caches
cannot be cleared, can leak memory, and can produce cross-realm `Error`
identity problems.

Sources: [Vitest pool](https://vitest.dev/config/pool),
[Vitest isolation](https://vitest.dev/config/isolate).

Vitest enables isolation by default. Keep it enabled. Start with one fork to
match the current `--max-concurrency=1` baseline. Only after repeated serial
equivalence may a bounded fork count be benchmarked under the 8 CPU / 4 GiB /
512 PID container. Do not infer safety from file isolation: parallel files can
still collide through inherited environment, shared paths, ports, or external
child processes.

Vitest supports V8 and Istanbul coverage; V8 is the default. Since Vitest 3.2,
its V8 provider uses AST-aware remapping and claims reports identical to
Istanbul, but that is a provider-level claim, not equivalence with Bun's
coverage accounting. Use exact include/exclude rules and compare the complete
file set plus line, branch, function, and statement counts. A percentage-only
comparison is insufficient.

Source: [Vitest coverage](https://vitest.dev/guide/coverage).

### Node built-in runner

Node's runner has the strongest dependency-minimization argument and native
runtime fidelity. It supports process-level isolation and V8 coverage, but the
Node 22 documentation still labels coverage experimental. More importantly,
the suite is authored against Jest-style `expect`, hooks, and `.each`; adopting
`node:test` would require a broader assertion/parameterization rewrite or an
additional compatibility layer. That creates more migration surface than
Vitest without improving runtime fidelity, since both execute under Node.

Source: [Node 22 test runner](https://nodejs.org/docs/latest-v22.x/api/test.html),
including “Test runner execution model” and “Collecting code coverage”.

`node:test` remains a reasonable future candidate if dependency removal becomes
a goal, but it is not the maintainability-first choice for this evaluation.

## Pre-prototype plan and acceptance contract

The following was the plan used to evaluate the candidate. It is historical
acceptance evidence, not remaining implementation work. The prototype used an
exact `vitest@4.1.10` / `@vitest/coverage-v8@4.1.10` pair and a checked-in
configuration with:

- Node environment, `pool: "forks"`, `isolate: true`, and one worker for the
  serial baseline;
- explicit test include patterns matching all 78 current files, so discovery
  cannot silently shrink;
- explicit 5-second default timeout unless repository evidence requires a
  documented exception;
- explicit environment-contract tests for `NODE_ENV` and timezone if code
  relies on Bun's defaults;
- V8 coverage with explicit source include/exclude patterns and thresholds;
- failure on unhandled errors/rejections, open handles, or worker teardown
  failures rather than suppressing them.

The plan required benchmarking Bun serial, Vitest serial, and only
demonstrably safe bounded Vitest fork counts in the same pinned Docker image
and cgroup limits. It required warmup,
at least five measured full runs per configuration, wall time, peak cgroup
memory, peak/current PID counts, exit status, discovered files/tests, and raw
logs. Alternate runner order or document cache controls. Run the built Node
artifact's contract tests under Node as well; a source-only Vitest pass does not
preserve the Bun build contract.

Migration gates:

1. Exactly the same intended 78 files and test cases are collected; every
   intentional difference is reviewed, never hidden with excludes or skips.
2. Exact coverage file-set and counter equivalence is established, or a
   source-mapped provider difference is explained line-by-line and gates are
   no weaker.
3. Repeated full runs show no flakes, leaks, unhandled errors, OOMs, PID-limit
   pressure, or orphan child processes.
4. Node 22 compatibility and Node 24 results both pass, preserving the declared
   package floor and current production-family fidelity.
5. Bun build/package contract tests remain green.
6. The result is maintainable and either meaningfully faster or materially more
   production-faithful. Runtime fidelity alone may justify a modest slowdown,
   but the measured trade-off must be recorded in the final ADR.

These gates failed, so the prototype changes were removed and ADR-0004 records
“retain Bun” with the benchmark evidence. In particular, the evaluation did
not force parallelism after the previous Bun epoll/stdout worker race; Vitest
parallelism was treated as a separate configuration requiring its own safety
evidence.
