# ADR-0004: Keep Bun for CLI Tests

**Status:** Accepted
**Date:** 2026-07-18
**Deciders:** Clawdi maintainers

## Context

The published CLI runs on Node.js 22.5 or newer, and Bun builds its distribution
with `--target node`. Its test suite, however, runs on the pinned Bun 1.3.14
runtime. We evaluated whether moving the suite to a Node-native runner would
make tests faster or more faithful to the published package without weakening
coverage or the Bun build contract.

The baseline has 78 TypeScript test files, 1,011 tests, and 4,833 `expect`
calls. All 78 import `bun:test`. The test DSL usage is deliberately small:
`describe`, `it`/`test`, lifecycle hooks, and `expect`; there are no Bun test
mock, fake-timer, or snapshot APIs.

The runtime contract is not limited to that import:

- Six files contain 12 `Bun.spawn` call sites plus two `ReturnType` references;
  four E2E files each contain one `Bun.serve` call and one type reference.
- The Hermes adapter test uses `bun:sqlite` to read its real fixture database.
- Four files use Bun's `import.meta.dir` extension.
- Tests use Bun-specific `toBeString` (three calls) and `toStartWith` (one call)
  matchers.
- Smoke and command-help tests deliberately run the TypeScript source entry
  through Bun. Binary-wrapper tests separately run the built distribution
  through Node. Together these preserve both the Bun build input and published
  Node output contracts.
- Tests mutate `process.env`, `cwd`, exit state, global `fetch`, and filesystem
  state. The serial isolated runner is intentional; previous Bun worker
  parallelism reproduced an epoll/stdout race.

## Prototype

Vitest 4.1.10 was selected for the prototype because it supports Node 24,
provides per-file isolation and fork pools, and has the closest Jest-compatible
API to the current DSL. The prototype aliased `bun:test` to `vitest`; it did not
hide or skip incompatible files.

Runs used the repository test-runner image with Node 24.18.0 and Bun 1.3.14,
limited to 8 CPUs, 4 GiB memory, and 512 PIDs. `HOME` and `/tmp` were throwaway
container paths. Times are wall-clock milliseconds. Memory and PID values are
cgroup peaks; all runs reported zero OOM and OOM-kill events.

| Runner | Configuration | Repeats | Result | Wall time | Peak memory | Peak PIDs |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| Bun | `--isolate --max-concurrency=1` | 2 | 1,011 pass, 0 fail; 4,833 expects | 21,925; 21,522 | 269,901,824 B | 58 |
| Vitest | forks, isolated, serial files, 1 worker | 2 | 976 discovered; 943 pass, 24 fail, 9 pending; 20 failed suites | 43,963; 42,819 | 498,548,736 B | 81 |
| Vitest | forks, isolated, parallel files, 4 workers | 1 | Same incomplete/failing counts as serial | 13,783 | 677,847,040 B | 108 |

The Node serial result is about 2x slower than Bun before doing the compatibility
work. Parallel Vitest is faster, but it is not a valid result: 35 baseline tests
are absent from its discovered count, 24 fail, and collection fails for multiple
files. It therefore provides neither assertion nor source-coverage equivalence.
Its failures are deterministic across repeats rather than flaky or leaked work.

The failures fall into concrete compatibility groups: unavailable Bun globals,
`bun:sqlite`, undefined `import.meta.dir`, Bun-only matchers, and two matcher or
path assertions whose behavior differs under Vitest. The four E2E files also
type and create `Bun.serve` servers when their opt-in gates are enabled. Replacing
those APIs would be a test-harness rewrite, not a runner-only migration, and
would remove direct coverage of contracts that the Bun build still needs.

Relevant upstream contracts:

- [Bun test runner](https://bun.com/docs/test)
- [Bun test isolation](https://bun.com/docs/test/runtime-behavior#isolation)
- [Bun process APIs](https://bun.com/docs/runtime/child-process)
- [Bun SQL SQLite](https://bun.com/docs/runtime/sqlite)
- [Vitest isolation and pools](https://vitest.dev/config/isolate)
- [Vitest file parallelism](https://vitest.dev/config/fileparallelism)
- [Vitest migration guide](https://vitest.dev/guide/migration)
- [Node.js package entry points](https://nodejs.org/api/packages.html#package-entry-points)
- [Node.js built-in test runner](https://nodejs.org/api/test.html)

Node's built-in test runner was not prototyped further. It has a different
assertion and lifecycle surface, so it would require at least the same runtime
compatibility work plus a larger 78-file DSL rewrite. It offers no evidence-based
advantage over the closer Vitest prototype.

## Decision

Keep the CLI test runner on pinned Bun 1.3.14 and retain its serial isolated
configuration:

```text
bun test --isolate --max-concurrency=1
```

Keep Bun as package manager and build tool, and keep the existing Node execution
smoke tests for the built package. Do not enable Bun worker parallelism or adopt
Vitest's faster four-worker result: neither has demonstrated the required stable
and coverage-equivalent behavior.

## Options Considered

| Option | Complexity | Stability/coverage | Runtime fidelity | Measured speed |
| --- | --- | --- | --- | --- |
| Keep Bun serial | Low | Full baseline passes; existing isolation contract | Covers Bun source/build input plus separate Node package smoke tests | ~22 s |
| Vitest serial on Node | High | Incomplete discovery and deterministic failures | Better default runtime fidelity, but requires Bun compatibility shims or contract rewrites | ~43 s |
| Vitest with four forks | High | Same incomplete/failing coverage; shared-state safety unproven | Same limitations as serial Vitest | ~14 s invalid prototype |
| Node built-in test runner | Higher | Not prototyped after API inventory showed a larger DSL rewrite | Native Node, but still cannot run Bun APIs | No valid measurement |

## Trade-off Analysis

The strongest argument for a Node runner is production-runtime fidelity. This
suite already splits that responsibility: Bun tests the TypeScript source and
build contracts, while Node executes the built wrapper/package in focused smoke
tests. Replacing the whole runner would improve the default runtime but either
drop the Bun contracts or recreate them behind a compatibility layer.

The only measured speed win came from four-way file parallelism before the Node
suite was equivalent. It cannot be compared with the passing Bun baseline, and
the suite's process/environment/global-state inventory makes parallel safety a
separate migration project. Serial Vitest is slower and consumes more memory
and PIDs. The maintenance and coverage costs therefore outweigh the unproven
fidelity benefit.

## Consequences

- The full suite remains maintainable and green with no compatibility shim.
- Tests retain direct coverage of Bun source/build contracts while built-package
  smoke tests cover the declared Node runtime.
- Test runtime remains approximately 22 seconds under the constrained runner.
- A Node runner is not added as a dependency, so install size and two-runner
  configuration drift are avoided.
- Production fidelity should continue to improve through focused tests that run
  `dist` and `bin/clawdi.mjs` with Node, rather than by moving Bun-specific build
  contract tests onto a partial compatibility layer.

## Reconsideration Criteria

The runner decision is based on Bun 1.3.14 and the current suite; it is not a
permanent ban on Bun parallelism. Re-evaluate a Node runner when the suite no
longer depends on Bun runtime APIs, or when a Node prototype passes all 1,011
tests and the same coverage gates across repeated serial runs.

Re-evaluate Bun parallel workers after a pinned Bun upgrade only when a minimal
reproduction or upstream evidence shows that the epoll/stdout worker race is
fixed. Then rerun repeated full-suite equivalence benchmarks under the 8 CPU,
4 GiB, 512 PID limit and require identical test and coverage gates, stable
stdout/child-process completion, and no flakes, leaks, or resource-limit
failures before changing the serial configuration.
