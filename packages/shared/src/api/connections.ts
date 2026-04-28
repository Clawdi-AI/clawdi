/**
 * Typed connection API types — re-exported from the auto-generated
 * `deploy-generated.ts` (which despite its name contains the full
 * clawdi-monorepo OpenAPI schema, including `/connections/*`).
 *
 * Regenerate with:
 *
 *     bun --cwd apps/web run generate-deploy-api
 *
 * (requires clawdi-monorepo's backend running on :50021).
 */
import type { components as DeployComponents } from "./deploy-generated";

type S = DeployComponents["schemas"];

export type ConnectionItem = S["ConnectionItem"];
export type ConnectionListResponse = S["ConnectionListResponse"];
export type AvailableAppItem = S["AvailableAppItem"];
export type AvailableAppListResponse = S["AvailableAppListResponse"];
export type ConnectorCatalogResponse = S["ConnectorCatalogResponse"];
export type ConnectorToolsResponse = S["ConnectorToolsResponse"];
export type AuthFieldsResponse = S["AuthFieldsResponse"];
export type ConnectRequest = S["ConnectRequest"];
export type ConnectResponse = S["ConnectResponse"];
export type ConnectionVerifyResponse = S["ConnectionVerifyResponse"];
export type ConnectionDisconnectResponse = S["ConnectionDisconnectResponse"];
