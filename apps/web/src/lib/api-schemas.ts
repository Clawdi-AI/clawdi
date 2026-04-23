/**
 * Ergonomic re-exports of the auto-generated OpenAPI types.
 *
 * The raw generated file (`api-types.generated.ts`) models every endpoint as
 * `paths["/api/..."]["get"]["responses"]["200"]["content"]["application/json"]`
 * which is unreadable at call sites. This module hoists the common response
 * and request shapes to top-level aliases that pages actually want.
 *
 * Regenerate after backend changes with: `bun run generate-api`.
 */

import type { components } from "./api-types.generated";

type Schemas = components["schemas"];

// ── Auth ─────────────────────────────────────────────────────────────────
export type CurrentUser = Schemas["CurrentUserResponse"];
export type ApiKey = Schemas["ApiKeyResponse"];
export type ApiKeyCreated = Schemas["ApiKeyCreated"];
export type ApiKeyCreate = Schemas["ApiKeyCreate"];

// ── Dashboard ────────────────────────────────────────────────────────────
export type DashboardStats = Schemas["DashboardStatsResponse"];
export type ContributionDay = Schemas["ContributionDayResponse"];

// ── Sessions ─────────────────────────────────────────────────────────────
export type SessionListItem = Schemas["SessionListItemResponse"];
export type SessionDetail = Schemas["SessionDetailResponse"];
export type Environment = Schemas["EnvironmentResponse"];

// ── Memories ─────────────────────────────────────────────────────────────
export type Memory = Schemas["MemoryResponse"];
export type MemoryCreate = Schemas["MemoryCreate"];

// ── Skills ───────────────────────────────────────────────────────────────
export type SkillSummary = Schemas["SkillSummaryResponse"];
export type SkillDetail = Schemas["SkillDetailResponse"];
export type SkillInstallRequest = Schemas["SkillInstallRequest"];

// ── Vault ────────────────────────────────────────────────────────────────
export type Vault = Schemas["VaultResponse"];
export type VaultItems = Schemas["VaultSectionsResponse"];
export type VaultItemUpsert = Schemas["VaultItemUpsert"];

// ── Connectors ───────────────────────────────────────────────────────────
export type ConnectorConnection = Schemas["ConnectorConnectionResponse"];
export type ConnectorApp = Schemas["ConnectorAvailableAppResponse"];
export type ConnectorTool = Schemas["ConnectorToolResponse"];
export type ConnectorMcpConfig = Schemas["ConnectorMcpConfigResponse"];

// ── Settings ─────────────────────────────────────────────────────────────
export type UserSettings = Schemas["SettingsResponse"];
