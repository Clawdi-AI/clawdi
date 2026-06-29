# Web Agent Notes

The web app uses TanStack Start with TanStack Router, Vite, Clerk, shadcn/ui,
and Tailwind CSS. Routes live under `src/routes/`; shared dashboard UI and
legacy page components still live under `src/app/` during the migration.

Run `bun run --cwd apps/web typecheck` after route changes so
`src/routeTree.gen.ts` is regenerated before TypeScript checks.
