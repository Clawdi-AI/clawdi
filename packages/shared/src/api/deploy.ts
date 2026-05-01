/**
 * Typed deploy-api types — re-exported from auto-generated
 * `deploy.generated.ts`. Regenerate with:
 *
 *     bun --cwd apps/web run generate-deploy-api
 *
 * (requires clawdi.ai running on :50021).
 */
import type { components as DeployComponents } from "./deploy.generated";

export type { components as DeployComponents, paths as DeployPaths } from "./deploy.generated";

type S = DeployComponents["schemas"];

// Phase 1 only ships the read path (`GET /deployments`). Plan,
// Subscription, AgentCatalogItem, DeployRequest aren't consumed yet
// — re-add them when the in-app deploy dialog (Phase 2) lands so we
// don't ship dead exports. The full schema is still reachable via
// `DeployComponents["schemas"]` for one-off probing.
export type Deployment = S["DeploymentResponse"];
