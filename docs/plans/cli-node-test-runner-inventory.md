# CLI Node Test Runner Compatibility Inventory

Status: evidence for an ADR; this document does not recommend or implement a
runner migration.

Baseline: repository commit `1238cad1b24132b4a77fcaadb7f8653d9f6cb2e5`, Bun
`1.3.14`, Linux. The production package declares Node `>=22.5`, but the local
measurement host had Node `24.18.0`; no Node-runner result in this document may
therefore be treated as a Node 22 result.

## Result

The 78 CLI test files are not a runner-neutral Jest subset. Their direct
`bun:test` API is small, and they have no runner mocks, fake timers, or test
snapshots. However, 11 files directly depend on Bun runtime APIs or Bun-only
module metadata, and process E2E tests depend on the runner executable being
Bun. A prototype must port or explicitly retain those contracts before its
test count can be compared with the current suite.

The existing serial command passed once with exactly 1,011 tests, 4,833
`expect()` calls, zero failures, and no reported unhandled errors:

```text
$ /usr/bin/time -v bun run --cwd packages/cli test
1011 pass
0 fail
4833 expect() calls
Ran 1011 tests across 78 files. [27.18s]
Elapsed (wall clock): 27.23s
Maximum resident set size: 311256 kbytes
Exit status: 0
```

This is an inventory validation run, not a reproducible benchmark series. The
ADR benchmark must run in the specified 8 CPU, 4 GiB, 512 PID container and
report repeated samples.

## Direct `bun:test` Surface

All 78 files use named ESM imports. No file uses a default import, namespace
import, `require("bun:test")`, globals supplied by a preload, or auto-injected
test globals.

| Import | Files importing it |
| --- | ---: |
| `describe` | 78 |
| `expect` | 78 |
| `it` | 66 |
| `test` | 12 |
| `afterEach` | 49 |
| `beforeEach` | 39 |
| `afterAll` | 9 |
| `beforeAll` | 4 |

There are no `.skip`, `.todo`, `.only`, `.concurrent`, or `.serial`
declarations. There are also no per-test timeout options. The suite uses two
Bun/Jest-extension matchers which need an explicit compatibility decision:

- `toBeString()` occurs three times:
  `tests/commands/auth.test.ts` and
  `tests/e2e/daemon-rpc.e2e.test.ts` (twice).
- `toStartWith()` occurs once in `tests/commands/runtime.test.ts`.

The remaining observed assertions use ordinary equality, identity, numeric,
property, containment, regex, throw, instance, truthiness, and promise
resolution/rejection matchers. A migration should still let the candidate
runner typecheck every assertion instead of assuming the names imply identical
edge semantics.

### Negative inventory

Repository searches found none of the following in CLI tests:

- `mock()`, `mock.module()`, `spyOn()`, `jest.*`, or `vi.*` calls;
- fake clocks, `setSystemTime`, or timer advancement APIs;
- `toMatchSnapshot`, inline snapshots, or snapshot files;
- `preload`, `setupFiles`, global setup, or a CLI `bunfig.toml` test setup;
- test-level concurrency modifiers or explicit test timeouts.

Comments in `src/commands/serve-cli-options.test.ts` and
`src/commands/serve-cli.ts` are still important evidence: the production
seam exists specifically because `mock.module` state was observed to bleed
across Bun test files. A Node prototype must keep testing the production seam,
not reintroduce a parallel mock tree merely because another runner's module
mock implementation differs.

## Bun Runtime Dependencies

### HTTP servers

Four E2E files create in-process ephemeral servers with `Bun.serve({ port: 0,
fetch })` and shut them down in `afterAll`:

- `tests/e2e/ai-provider.e2e.test.ts`
- `tests/e2e/credential-profile.e2e.test.ts`
- `tests/e2e/daemon-rpc.e2e.test.ts`
- `tests/e2e/vault-reference.e2e.test.ts`

A replacement must preserve ephemeral loopback binding, Fetch API
request/response behavior, the exposed origin/port, and forceful async-safe
shutdown. These are real-server tests, not mocked fetch tests.

### Child processes and runtime identity

Six files use `Bun.spawn` (12 call sites total). Two additional
`ReturnType<typeof Bun.spawn>` annotations in the daemon E2E bring the raw text
search to 14 references; the ADR reports both definitions explicitly.

- `tests/smoke.test.ts` (five)
- `tests/commands/agent-projects.test.ts` (two)
- `tests/e2e/daemon-rpc.e2e.test.ts` (two)
- `tests/e2e/ai-provider.e2e.test.ts`
- `tests/e2e/credential-profile.e2e.test.ts`
- `tests/e2e/vault-reference.e2e.test.ts`

Four more files import Node `child_process` APIs:

- `src/runtime/manifest-reconciliation.test.ts`
- `tests/commands/run.test.ts`
- `tests/runtime-mitmproxy-fetch.test.ts`
- `tests/runtime.test.ts`

The strongest runner coupling is in all four E2E files: they spawn
`[process.execPath, src/index.ts, ...args]`. Under `bun test`,
`process.execPath` is Bun and executes TypeScript directly. Under a Node runner
it is Node, so the same line changes both the runtime under test and TypeScript
loading behavior. The prototype must make this choice explicit:

1. spawn Bun to preserve the source-entry contract (less production-faithful),
2. build and spawn the Node-targeted distribution (more production-faithful,
   but introduces a build fixture and changes coverage attribution), or
3. use an explicitly pinned Node TypeScript loader and document that this is
   neither the published artifact nor today's Bun contract.

`tests/smoke.test.ts` separately exercises the source entry with an explicit
`bun` command and conditionally exercises the built wrapper with explicit
`node`. The built-wrapper assertions return early when `dist/index.js` is
missing, and the stdin assertion also returns early for a stale build
containing `Bun.stdin`. Those are silent conditional passes, not runner skips;
coverage-equivalence tooling must identify whether each body actually ran.

Bun documents that a timed-out Bun test kills child processes spawned by that
test. A candidate runner needs an explicit child cleanup contract, especially
for the daemon E2E, rather than relying on a superficially similar timeout.

### SQLite

`tests/adapters/hermes.test.ts` imports `Database` from `bun:sqlite` to mutate a
fixture database. Production `src/adapters/hermes.ts` deliberately loads
`bun:sqlite` under Bun and Node's built-in `node:sqlite` under Node. Running the
test under Node cannot resolve its current static import, and mechanically
switching it to `node:sqlite` would stop covering the Bun development path.
The ADR must decide whether to parameterize this contract and test both
implementations, or retain a focused Bun contract test alongside Node tests.

### ESM metadata and resolution

Four files use Bun's `import.meta.dir`:

- `tests/clean-test-runner.test.ts`
- `tests/cli-publish-workflow.test.ts`
- `tests/runtime.test.ts`
- `src/runtime/runtime-bundle-v2.test.ts`

Six files use standard `import.meta.url`; four E2E files convert it through
`fileURLToPath`, `tests/commands/agent-projects.test.ts` reads a URL pathname
directly, and `tests/smoke.test.ts` uses `fileURLToPath`. Eleven files use
dynamic `import()`, including test-time imports after environment or global
mutation. A Node runner must preserve ESM mode, relative resolution, module
cache timing, and URL decoding. Replacing `import.meta.dir` with
`import.meta.dirname` is valid only at the repository's Node floor: Node's
official ESM documentation records `import.meta.dirname` as non-experimental
from Node 22.16.0, while the package floor is currently 22.5.0. A
`fileURLToPath(import.meta.url)` helper is compatible with the existing floor.

## Mutable Process and Global State

The current command is intentionally serial and isolated:

```json
"test": "bun test --isolate --max-concurrency=1"
```

Fifty-five files read or write `process.env`; many snapshot and restore values
in hooks, while `tests/runtime.test.ts` alone contains hundreds of environment
assignments. Four files call `process.chdir()` and restore the original cwd:

- `tests/commands/read-inject.test.ts`
- `tests/commands/run.test.ts`
- `tests/commands/skill.test.ts`
- `tests/project-folders.test.ts`

Four files replace `globalThis.fetch` and restore it:

- `src/commands/serve-handlers.test.ts`
- `src/runtime/runtime-bundle-v2.test.ts`
- `src/serve/sse-client.test.ts`
- `tests/api-client.test.ts`

Seven files use real `setTimeout` calls, including socket/daemon deadlines and
lock staleness checks; none uses fake timers. File isolation alone does not
make tests within a file safe to run concurrently, and process cwd is shared
across worker threads. Any candidate configuration must therefore start with
one test at a time and prove a process-based file parallel mode separately.
It must not enable worker/thread parallelism by default in response to timing
alone, particularly given the previously reproduced Bun epoll/stdout worker
race.

Platform-conditional early returns also exist: six installer tests only run on
macOS, one installer test and one serve-handler test only run on Linux, and
some credential tests branch or return on macOS/Windows. The baseline output
reports no skips because early returns count as passes. Exact test-count
equivalence is necessary but insufficient; the benchmark container must also
record platform and verify the same conditional bodies.

## Isolation and Setup Contract

There is no preload/setup file. Isolation is supplied only by the CLI flag and
by test-owned hooks/temporary directories. Bun's official runtime behavior
documentation says `bun test` runs in a single process and describes
`--isolate` as reloading the environment for each test file. Candidate runner
configuration must be evaluated against these concrete requirements:

- fresh ESM module state between files, including modules dynamically imported
  after env/global changes;
- no concurrent mutation of `process.env`, cwd, or global fetch;
- completed `afterAll` shutdown for HTTP servers and daemon children;
- no surviving timers, sockets, file watchers, or child processes;
- temporary HOME/CLAWDI_HOME trees remain private to the owning test;
- stdout/stderr pipes are fully drained before process exit.

Vitest's official documentation distinguishes file isolation, worker pools,
and `.concurrent` tests. Therefore `pool`, worker count, file parallelism, and
`isolate` are separate benchmark variables; “serial” must be expressed and
verified rather than inferred from a single option.

## Runner and Build Contracts Outside the Test Files

A migration affects repository contract tests and CI strings as well as the
78 imports:

- `packages/cli/package.json` pins the serial Bun test command.
- `.github/workflows/client-ci.yml` directly runs
  `bun test --isolate --max-concurrency=1 packages/cli`.
- `tests/clean-test-runner.test.ts` asserts that exact client CI command and
  that the clean runner routes through the package script.
- `tests/cli-publish-workflow.test.ts` asserts the release workflow's exact Bun
  test command.
- `docker/test-runner.sh` invokes the package test script and has a separate
  direct Bun runner-contract test.
- `packages/cli/tsconfig.json` includes only `types: ["bun"]`; a Node runner's
  types/config must not remove types needed for Bun build scripts or the
  retained Bun production/development paths.
- `bun.lock` has `@types/bun@1.3.14` and no pinned Vitest package. Bun remains
  the declared package manager and Node-targeted build tool regardless of the
  runner decision.

The build itself remains a Bun contract: `bun build ... --target node`, binary
packaging uses `Bun.build`, and fixture generation uses `bun:sqlite`. A Node
test runner must not be used as justification to remove these contracts.

## Exact File Set

The following command is the authoritative, reproducible inventory and must
continue to print `78` until the migration intentionally changes imports:

```bash
rg -l -g '*.test.ts' -g '*.test.tsx' 'bun:test' packages/cli | sort | wc -l
```

The set comprises 23 colocated `src/**/*.test.ts` files, 51 non-E2E
`tests/**/*.test.ts` files, and these four process E2E files:

```text
packages/cli/tests/e2e/ai-provider.e2e.test.ts
packages/cli/tests/e2e/credential-profile.e2e.test.ts
packages/cli/tests/e2e/daemon-rpc.e2e.test.ts
packages/cli/tests/e2e/vault-reference.e2e.test.ts
```

To inspect every path rather than rely on this grouping:

```bash
rg -l -g '*.test.ts' -g '*.test.tsx' 'bun:test' packages/cli | sort
```

Done: the first command prints `78`; the second command's set exactly matches
the files reported by `bun test` in the baseline run.

## Required Prototype Gates

Before an ADR can recommend migration, the prototype must demonstrate all of
the following without hidden skips or reduced gates:

1. Exactly 78 files, 1,011 tests, and 4,833 assertions, or a reviewed mapping
   explaining every intentional count change.
2. Both Bun SQLite and Node SQLite production paths remain covered.
3. Source-entry Bun smoke and built-artifact Node smoke remain distinct and
   named; conditional early-pass bodies are reported.
4. Serial repeated runs show no leaked handles/processes, unhandled rejection,
   uncaught exception, OOM, or PID exhaustion.
5. Any parallel candidate uses process isolation, has independent HOME/cwd,
   stays within 8 CPU/4 GiB/512 PID, and is rejected if it revives the
   epoll/stdout race or creates flakes.
6. Bun package management and `bun build --target node` contracts remain green.
7. Coverage is compared by exact test/node mapping, not only a percentage; the
   candidate must not omit platform/runtime-specific nodes.

## Official References

Checked 2026-07-18:

- [Bun test runtime behavior](https://bun.sh/docs/test/runtime-behavior) —
  process integration and file isolation.
- [Bun writing tests](https://bun.sh/docs/test/writing) — `bun:test` API,
  matchers, timeout behavior, and child-process cleanup.
- [Bun mocks](https://bun.sh/docs/test/mocks) and
  [snapshots](https://bun.sh/docs/test/snapshots) — negative-inventory API
  definitions.
- [Vitest features](https://vitest.dev/guide/features.html) and
  [pool configuration](https://vitest.dev/config/pool) — isolation,
  concurrency, and worker-pool distinctions. These references describe a
  candidate, not a preselected decision.
- [Node 22 ESM documentation](https://nodejs.org/docs/latest-v22.x/api/esm.html#importmetadirname)
  — `import.meta.dirname` version history and URL-based ESM behavior.
- [Node 22 TypeScript documentation](https://nodejs.org/docs/latest-v22.x/api/typescript.html)
  — version-specific native TypeScript limitations; the package's `>=22.5`
  floor must govern, not the developer machine's newer Node.
