/**
 * Connection types from clawdi.ai's OpenAPI dump (the file
 * `deploy-generated.ts` carries the full schema despite its name).
 *
 * Regenerate with:
 *
 *     bun --cwd apps/web run generate-deploy-api
 */
import type { components as DeployComponents } from "./deploy-generated";

type S = DeployComponents["schemas"];

export type ConnectionItem = S["ConnectionItem"];
export type ConnectorCatalogItem = S["ConnectorCatalogItem"];
