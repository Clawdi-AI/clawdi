/**
 * Typed deploy-api types — re-exported from auto-generated
 * `deploy.generated.ts`. Regenerate with:
 *
 *     bun --cwd apps/web run generate-deploy-api
 *
 * The default source is the local hosted API on `:50021`. To regenerate
 * against the live hosted contract that CI checks, run:
 *
 *     DEPLOY_OPENAPI_SOURCE=https://api.clawdi.ai/openapi.json \
 *       bun --cwd apps/web run generate-deploy-api
 *
 * The generated file is intentionally a FILTERED subset of the hosted
 * deploy API OpenAPI surface — `scripts/filter-deploy-openapi.py` keeps only the
 * endpoints listed in its `KEEP_OPERATIONS_BY_PATH` allowlist plus their transitive
 * schema closure. Adding a new operation = adding it to that allowlist
 * + running the regen command. See the filter script for details.
 */
import type { components as DeployComponents } from "./deploy.generated";

export type { components as DeployComponents, paths as DeployPaths } from "./deploy.generated";

type S = DeployComponents["schemas"];

export type Deployment = S["V2HostedDeploymentResponse"];
