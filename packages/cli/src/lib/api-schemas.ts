// Ergonomic aliases over the auto-generated OpenAPI types. Source of truth
// is `@clawdi/shared/api/api.generated.ts`; regenerate with
// `bun run generate-api` from the repo root after backend schema changes.
import type { components, paths } from "@clawdi/shared/api";

type Schemas = components["schemas"];

export type SessionListQuery = NonNullable<paths["/v1/sessions"]["get"]["parameters"]["query"]>;

// ── Read responses ────────────────────────────────────────────────────────
export type Memory = Schemas["MemoryResponse"];
export type SkillSummary = Schemas["SkillSummaryResponse"];
export type AgentProfile = Schemas["AgentProfileResponse"];
export type SessionListItem = Schemas["SessionListItemResponse"];
export type SessionDetail = Schemas["SessionDetailResponse"];
export type SessionMessage = Schemas["SessionTimelineMessageResponse"];
