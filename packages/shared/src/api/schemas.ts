/**
 * Ergonomic re-exports of the auto-generated OpenAPI types.
 *
 * The raw generated file (`api.generated.ts`) models every endpoint as
 * `paths["/v1/..."]["get"]["responses"]["200"]["content"]["application/json"]`
 * which is unreadable at call sites. This module hoists the common response
 * and request shapes to top-level aliases that pages actually want.
 *
 * Regenerate after backend changes with: `bun run generate-api`.
 */

import type { components } from "./api.generated";

type Schemas = components["schemas"];

// ── Auth ─────────────────────────────────────────────────────────────────
export type CurrentUser = Schemas["CurrentUserResponse"];
export type ApiKey = Schemas["ApiKeyResponse"];
export type ApiKeyCreated = Schemas["ApiKeyCreated"];
export type ApiKeyCreate = Schemas["ApiKeyCreate"];
export type ApiKeyRevoked = Schemas["ApiKeyRevokeResponse"];

// ── Dashboard ────────────────────────────────────────────────────────────
export type DashboardStats = Schemas["DashboardStatsResponse"];
export type ContributionDay = Schemas["ContributionDayResponse"];

// ── Sessions ─────────────────────────────────────────────────────────────
export type SessionListItem = Schemas["SessionListItemResponse"];
export type SessionDetail = Schemas["SessionDetailResponse"];
export type SessionMessage = Schemas["SessionMessageResponse"];
export type SessionUploadResult = Schemas["SessionUploadResponse"];
export type Environment = Schemas["EnvironmentResponse"];
export type Agent = Schemas["EnvironmentResponse"];

// ── Memories ─────────────────────────────────────────────────────────────
export type Memory = Schemas["MemoryResponse"];
export type MemoryCreate = Schemas["MemoryCreate"];
export type MemoryDeleted = Schemas["MemoryDeleteResponse"];
export type EmbedBackfillResult = Schemas["EmbedBackfillResponse"];

// ── Skills ───────────────────────────────────────────────────────────────
export type SkillSummary = Schemas["SkillSummaryResponse"];
export type SkillInstallRequest = Schemas["SkillInstallRequest"];
export type SkillUploadResult = Schemas["SkillUploadResponse"];
export type SkillDeleted = Schemas["SkillDeleteResponse"];

// ── Vault ────────────────────────────────────────────────────────────────
export type Vault = Schemas["VaultResponse"];
export type VaultItems = Schemas["VaultSectionsResponse"];
export type VaultItemUpsert = Schemas["VaultItemUpsert"];
export type VaultCreated = Schemas["VaultCreatedResponse"];
export type VaultDeleted = Schemas["VaultDeleteResponse"];
export type VaultItemsUpserted = Schemas["VaultItemsUpsertResponse"];
export type VaultItemsDeleted = Schemas["VaultItemsDeleteResponse"];
export type VaultResolved = Schemas["VaultResolveResponse"];

// ── Connectors ───────────────────────────────────────────────────────────
export type ConnectorConnection = Schemas["ConnectorConnectionResponse"];
export type ConnectorApp = Schemas["ConnectorAvailableAppResponse"];
export type ConnectorTool = Schemas["ConnectorToolResponse"];
export type ConnectorConnectResult = Schemas["ConnectorConnectResponse"];
export type ConnectorDisconnectResult = Schemas["ConnectorDisconnectResponse"];

// ── Settings ─────────────────────────────────────────────────────────────
export type UserSettings = Schemas["SettingsResponse"];
export type UserSettingsUpdated = Schemas["SettingsUpdateResponse"];

// ── Pagination + global search ───────────────────────────────────────────
export type SearchResponse = Schemas["SearchResponse"];
export type SearchHit = Schemas["SearchHit"];
