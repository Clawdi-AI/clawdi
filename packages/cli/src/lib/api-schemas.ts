// Ergonomic aliases over the auto-generated OpenAPI types. Source of truth
// is `@clawdi/shared/api/generated.ts`; regenerate with `bun run generate-api`
// from the repo root after backend schema changes.
import type { components } from "@clawdi/shared/api";

type Schemas = components["schemas"];

// ── Read responses ────────────────────────────────────────────────────────
export type Memory = Schemas["MemoryResponse"];
export type SkillSummary = Schemas["SkillSummaryResponse"];
export type SkillDetail = Schemas["SkillDetailResponse"];
export type ConnectorMcpConfig = Schemas["ConnectorMcpConfigResponse"];
export type SessionListItem = Schemas["SessionListItemResponse"];

// ── Write responses ───────────────────────────────────────────────────────
export type MemoryCreated = Schemas["MemoryCreatedResponse"];
export type SessionBatchResult = Schemas["SessionBatchResponse"];
export type EnvironmentCreated = Schemas["EnvironmentCreatedResponse"];
export type SkillInstallResult = Schemas["SkillInstallResponse"];
export type VaultResolved = Schemas["VaultResolveResponse"];
export type VaultSections = Schemas["VaultSectionsResponse"];

// ── Pagination ────────────────────────────────────────────────────────────
export type PaginatedMemories = Schemas["Paginated_MemoryResponse_"];
export type PaginatedSkills = Schemas["Paginated_SkillSummaryResponse_"];
export type PaginatedSessions = Schemas["Paginated_SessionListItemResponse_"];
export type PaginatedVaults = Schemas["Paginated_VaultResponse_"];
