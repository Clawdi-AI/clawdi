# Clean Test Runner

The default `bun run test` path runs the comprehensive `all` suite in an
isolated Docker workspace. Clean Test Runner CI uses a separate, first-class
`ci` profile to validate the harness once without replacing product CI or
weakening any developer-facing suite.

## Suite contract

Run the comprehensive entrypoints with:

```bash
scripts/test.sh              # full JS and backend suites
scripts/test.sh js           # full web, shared, sidecar, and CLI tests
scripts/test.sh web          # web typecheck, full tests, and OSS build
scripts/test.sh cli          # CLI typecheck and full tests
scripts/test.sh backend      # migrations and full pytest
```

The CI-only profile runs one dependency install and preserves these harness
contracts:

```bash
scripts/test.sh ci
```

- Workspace typecheck, which executes the web, CLI, shared, and sidecar
  package typecheck commands.
- The Clean Runner workflow/selection/resource contract test.
- The existing web OSS-boundary test and the full OSS build.
- All shared and WhatsApp sidecar tests.
- The existing CLI smoke test.
- Alembic migrations and the existing backend PostgreSQL smoke test.

Product workflows remain responsible for their full product suites. The
focused profile is intentionally rejected if extra arguments are supplied so
its selection cannot drift through an undocumented CI-only shell argument.

The shell implementation defines each package command once in a lower-level
primitive. The public `js`, `web`, `cli`, and `backend` wrappers and the `ci`
profile compose those same primitives with full or focused arguments. Install
steps remain in the wrappers, so every entrypoint installs JavaScript and
backend dependencies at most once per container.

Done: `scripts/test.sh ci` exits 0 and reports passing contract, web, shared,
sidecar, CLI, and backend smoke tests.

## Dynamic and static coverage

Pull requests and pushes dynamically execute `scripts/test.sh ci`. That runs
the shared workspace-typecheck, web-test, web-build, shared-test,
sidecar-test, CLI-test, and backend-test primitives. Web, CLI, and backend use
the focused files listed above; shared and sidecar remain complete.

The lightweight contract test statically verifies the composition layer:

- Every package command is owned by exactly one primitive.
- Public wrappers and `ci` call those primitives in the expected order.
- Focused arguments appear only at the `ci` composition boundary.
- Public suite dispatch, workflow selection, paths, and resources remain
  present.

Routine pull requests do not dynamically invoke every public wrapper or rerun
the full web, CLI, and backend product suites. For a core runner change,
Clean Test Runner CI exposes a deliberate full-suite workflow-dispatch gate:

```bash
gh workflow run clean-test-runner-ci.yml --ref <branch> -f suite=all
```

The dispatch runs `scripts/test.sh all` in the same built runner image and
measured Compose envelope. Its default choice remains `ci`. This is manual
rather than scheduled because product workflows already run the full product
suites; automatically repeating them on a calendar would add cost without
being tied to a runner change.

Done: the dispatched `docker-runner` job exits 0 and its `Full clean runner
suite` step reports the full web, shared, sidecar, CLI, and backend counts.

## Client CI gate independence

Client CI keeps web build and the web/CLI/shared typecheck matrix as separate
required jobs, but both now depend only on the path-filter job. Each job starts
from its own `actions/checkout` and neither uploads nor downloads an artifact.
The Turbo typecheck task also declares no outputs. Consequently, the previous
`build -> typecheck` scheduling edge could not transfer `tsr generate` output
or any other generated file to the build job.

A build-only check copied the repository into a fresh isolated runner
workspace, installed dependencies, asserted that `apps/web/.output` and
`apps/web/.tanstack` did not exist, and then ran:

```bash
bunx turbo build --filter=web
test -f apps/web/.output/server/index.mjs
```

The command passed without running typecheck first. This verifies the same
fresh-checkout contract already used by the Client CI build job.

## Resource envelope

`docker-compose.test.yml` applies these defaults to every clean-runner
invocation:

| Service | CPU | Memory | PIDs |
| --- | ---: | ---: | ---: |
| Test runner | 8 | 4 GiB | 512 |
| PostgreSQL | 2 | 1 GiB | 256 |

For each service, Compose sets `mem_limit` and `memswap_limit` to the same
positive value. Docker therefore gives the container no swap allowance. The
measured `memory.swap.peak` was also zero for both the high-ceiling and default
profile runs.

Override a limit for a constrained or larger local machine with:

| Variable | Default |
| --- | ---: |
| `CLAWDI_TEST_RUNNER_CPUS` | `8` |
| `CLAWDI_TEST_RUNNER_MEMORY_LIMIT` | `4g` |
| `CLAWDI_TEST_RUNNER_PIDS_LIMIT` | `512` |
| `CLAWDI_TEST_POSTGRES_CPUS` | `2` |
| `CLAWDI_TEST_POSTGRES_MEMORY_LIMIT` | `1g` |
| `CLAWDI_TEST_POSTGRES_PIDS_LIMIT` | `256` |

The memory variables set both the memory and memory-plus-swap values, so an
override preserves the no-swap invariant.

Done: `docker compose -f docker-compose.test.yml config` exits 0 and renders
the configured CPU, memory, memory-plus-swap, and PID values.

## Measurement evidence

Measurements were captured on 2026-07-18 with Docker 29.6.1, Docker Compose
5.3.1, cgroup v2, 32 logical CPUs, and 25,189,486,592 bytes of host memory.
Each command used a newly created container with the runner's per-run tmpfs
caches. Wall time covers `scripts/test.sh`; average CPU cores are cgroup
`cpu.stat` usage divided by wall time. Memory and PID values are cgroup
`memory.peak` and `pids.peak`.

The previous three-step workflow executed 2,981 test cases because the full
480-test web suite and 1,003-test CLI suite each ran twice:

| Previous step | Wall | Runner avg CPU | Runner memory peak | Runner PID peak | Tests |
| --- | ---: | ---: | ---: | ---: | ---: |
| `all tests/test_smoke.py` | 70.084 s | 1.740 | 2,703,486,976 B | 234 | 1,498 |
| `web` | 18.731 s | 2.991 | 2,550,808,576 B | 129 | 480 |
| `cli` | 31.970 s | 1.868 | 2,122,145,792 B | 85 | 1,003 |
| Total | 120.785 s | - | - | - | 2,981 |

The `all` step's 1,498 cases were 480 web, 9 sidecar, 1,003 CLI, and 6
backend smoke cases. A separate full backend run completed in 117.522 seconds
with 1,279 passed and 7 skipped tests. It peaked at 1,165,012,992 bytes and 87
PIDs in the runner and 182,202,368 bytes and 17 PIDs in PostgreSQL.

The current single-container `ci` profile executes 84 cases: 8 runner
contract, 14 web, 31 shared, 9 sidecar, 16 CLI, and 6 backend smoke tests. The
same profile was measured once with high override ceilings and once with the
defaults:

| Profile limits | Wall | Runner avg CPU | Runner memory peak | Runner PID peak | Swap peak | OOM kills |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 CPU / 16 GiB / 4,096 PID | 54.172 s | 2.032 | 2,670,735,360 B | 231 | 0 B | 0 |
| Default envelope | 53.359 s | 1.725 | 2,671,194,112 B | 83 | 0 B | 0 |

The comprehensive `all` suite was also rerun under the default envelope. It
completed in 148.518 seconds with 480 web, 31 shared, 9 sidecar, 1,011 CLI, and
1,279 passing backend tests; 7 backend tests were skipped. The runner peaked at
2,797,473,792 bytes and 83 PIDs, while PostgreSQL peaked at 184,459,264 bytes
and 17 PIDs. Both services recorded zero swap use and zero OOM kills.

The default runner memory limit retains more than 53% headroom over that
largest observed 2.80 GB peak, and its PID limit is more than twice the
unconstrained 234-process peak. PostgreSQL retains substantially more headroom
over the full backend run. The 8-CPU profile recorded transient cgroup
throttling but no measured wall time regression relative to the high-ceiling
run; the 0.813-second difference is treated as run-to-run noise, not a
performance gain.

These are sizing observations from one host, not general product benchmark
claims. The CI efficiency claim is limited to removing duplicate suite
execution and two repeated container dependency installs.

Done: `bun test packages/cli/tests/clean-test-runner.test.ts` reports 8 passing
contract tests.
