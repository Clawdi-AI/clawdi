# Clawdi Web

TanStack Start dashboard for Clawdi Cloud.

## Development

```bash
bun install
bun run --cwd apps/web dev
```

Open http://localhost:3000.

## Verification

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web test
bun run --cwd apps/web build
bun run --cwd apps/web build:oss
```

`typecheck` runs `tsr generate` first so TanStack Router's route tree stays in
sync with `src/routes/`.

`build:oss` forces `VITE_CLAWDI_HOSTED=false` and verifies the
self-hosted bundle path without local hosted `.env.local` values.
