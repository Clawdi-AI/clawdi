# Web Agent Notes

The web app uses TanStack Start with TanStack Router, Vite, Clerk, shadcn/ui,
and Tailwind CSS. Routes live under `src/routes/`; shared dashboard UI and
page-level components live under `src/pages/`.

Run `bun run --cwd apps/web typecheck` after route changes so
`src/routeTree.gen.ts` is regenerated before TypeScript checks.
