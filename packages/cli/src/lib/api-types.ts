/**
 * Re-exports of the shared OpenAPI-generated types under the CLI's legacy
 * names. Keeps the backend schema as the single source of truth — no more
 * hand-maintained shadow interfaces.
 */

import type { Memory, SkillSummary as SharedSkillSummary, SkillDetail } from "./api-schemas";

export type MemoryRecord = Memory;
export type SkillRecord = SkillDetail;
export type SkillSummary = SharedSkillSummary;
