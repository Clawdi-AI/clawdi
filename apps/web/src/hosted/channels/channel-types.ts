import type { components } from "@/lib/api-schemas";

/**
 * Local aliases for the native-channel response shapes.
 *
 * Each maps to a schema already present in main's generated cloud-api client,
 * so these are purely a convenience layer. We keep them in apps/web (rather
 * than re-exporting from the shared package) so this surface stays apps/web-only
 * — the shared `schemas.ts` convenience aliases ship with the cloud-api PR.
 */
type Schemas = components["schemas"];

export type ChannelAccount = Schemas["ChannelAccountResponse"];
export type ChannelCreate = Schemas["ChannelAccountCreate"];
export type ChannelCreated = Schemas["ChannelAccountCreatedResponse"];
export type ChannelBotPoolItem = Schemas["ChannelBotPoolItem"];
export type ChannelAgentLink = Schemas["ChannelAgentLinkResponse"];
export type ChannelBinding = Schemas["ChannelBindingResponse"];
export type ChannelActivityItem = Schemas["ChannelActivityItemResponse"];
