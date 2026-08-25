import type { components } from "@/lib/api-schemas";

/**
 * AI Provider API-response types, derived from the generated cloud-api schema.
 * Kept local to the hosted feature rather than aliased in `@clawdi/shared`,
 * whose root barrel already exports `AiProvider`/`AiProviderAuth` from the
 * hand-written provider-catalog module (those names would clash).
 */
type Schemas = components["schemas"];

export type AiProvider = Schemas["AiProviderResponse"];
export type AiProviderList = Schemas["AiProviderListResponse"];
export type AiProviderAuth = Schemas["AiProviderAuth"];
export type AiProviderUpsertAuth = Schemas["AiProviderUpsertAuth"];
export type AiProviderUpsert = Schemas["AiProviderUpsert"];
export type AiProviderPatch = Schemas["AiProviderPatch"];
export type AiProviderAcceptRequest = Schemas["AiProviderAcceptRequest"];
export type AiProviderAcceptResponse = Schemas["AiProviderAcceptResponse"];
export type AiProviderReadyAcceptResponse = Schemas["AiProviderReadyAcceptResponse"];
export type AiProviderConnectionTestRequest = Schemas["AiProviderConnectionTestRequest"];
export type AiProviderConnectionTestResponse = Schemas["AiProviderConnectionTestResponse"];
export type AiProviderOAuthDeviceStartResponse = Schemas["AiProviderOAuthDeviceStartResponse"];
export type AiProviderOAuthDevicePollResponse = Schemas["AiProviderOAuthDevicePollResponse"];
export type RuntimeObservedSummary = Schemas["RuntimeObservedSummaryResponse"];
