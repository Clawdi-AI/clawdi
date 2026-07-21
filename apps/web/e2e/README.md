# Web e2e

## Running Hosted E2e Locally

Start the local v2 deploy API mock from the repository root:

```bash
uv run --project backend python backend/scripts/mock_deploy_api.py
```

In another terminal, run the hosted Playwright suite:

```bash
cd apps/web
bun run e2e:hosted
```

The hosted Playwright config starts the web dev server with
`VITE_CLAWDI_HOSTED=true` and points `VITE_CLAWDI_DEPLOY_API_URL` at the mock
deploy API on `http://127.0.0.1:50001`. The specs stub only the cloud-api
surface they need; deploy, wallet, subscription, and status flows use the local
mock.
