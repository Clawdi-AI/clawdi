// Ergonomic aliases over the auto-generated OpenAPI types. Regenerate the
// source file with `bun run generate-api` after backend schema changes.
import type { components } from "./api-types.generated";

type Schemas = components["schemas"];

export type Memory = Schemas["MemoryResponse"];
export type SkillSummary = Schemas["SkillSummaryResponse"];
export type SkillDetail = Schemas["SkillDetailResponse"];
