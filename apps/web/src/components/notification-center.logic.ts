import type { components } from "@/lib/api-schemas";

export {
	type AccountNotification,
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterDescription,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	resolveNotificationUrl,
} from "@clawdi/shared/view";

type Schemas = components["schemas"];

export type ProjectInvitationNotification = Schemas["InvitationResponse"];
export type AcceptInvitationResponse = Schemas["InvitationAcceptResponse"];

// Project invitations are the first notification source. Keep the shell named
// generically so future notification types (agent health, billing, access
// changes) can join without replacing the header affordance.
export const NOTIFICATION_CENTER_QUERY_KEY = ["get", "/v1/me/invitations"] as const;
export const NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS = [
	NOTIFICATION_CENTER_QUERY_KEY,
	["skills"],
	["get", "/v1/projects"],
	["get", "/v1/agents"],
] as const;
