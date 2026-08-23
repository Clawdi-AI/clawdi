import { createHash } from "node:crypto";
import type { EgressProfileInputBundle } from "./egress-profiles";
import { toWebSocketUrl } from "./manifest-shared";
import { CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER } from "./whatsapp-upstream-contract";

type EgressProfile = EgressProfileInputBundle["profiles"][number];

export interface ManagedWhatsAppEgressLink {
	linkId: string;
	// The backend still authenticates the active Link with this bearer.
	agentTokenSecretRef: string;
	// This marker only selects one local profile; it is not backend authentication.
	capabilitySecretRef: string;
}

// Installing one of these profiles adds web.whatsapp.com to the proxy's SNI
// interception set. The marker is visible only after TLS inspection, so an
// unmarked connection is request-level passthrough to the official upstream,
// not byte-for-byte or TLS untouched.
export function buildManagedWhatsAppEgressProfiles(input: {
	controlPlaneApiUrl: string;
	links: ManagedWhatsAppEgressLink[];
}): EgressProfile[] {
	if (input.links.length === 0) return [];
	const upstreamBaseUrl = managedWhatsAppWebSocketUrl(input.controlPlaneApiUrl);
	const profiles = [...input.links]
		.sort((left, right) => left.linkId.localeCompare(right.linkId))
		.map(
			(link): EgressProfile => ({
				id: `native-whatsapp-baileys-${linkProfileSuffix(link.linkId)}`,
				enabled: true,
				kind: "websocket",
				match: {
					scheme: "wss",
					host: "web.whatsapp.com",
					path: { type: "equals", value: "/ws/chat" },
					headers: {
						[CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER]: {
							type: "secretRefEquals",
							secretRef: link.capabilitySecretRef,
						},
					},
					query: {},
				},
				rewrite: {
					upstreamBaseUrl,
					preservePath: false,
					removeHeaders: [CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER],
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: link.agentTokenSecretRef,
							prefix: "Bearer ",
						},
					},
				},
				logging: {
					redactHeaders: [CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER, "authorization"],
					redactUrlPatterns: [],
				},
				priority: 40,
				owner: "clawdi-native-whatsapp",
				description: "Route one authenticated managed native Baileys websocket.",
			}),
		);

	profiles.push({
		id: "native-whatsapp-baileys-invalid-capability",
		enabled: true,
		kind: "deny",
		match: {
			host: "web.whatsapp.com",
			headers: {
				[CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER]: { type: "exists" },
			},
			query: {},
		},
		logging: {
			redactHeaders: [CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER],
			redactUrlPatterns: [],
		},
		priority: 49,
		owner: "clawdi-native-whatsapp",
		description: "Fail closed when a managed WhatsApp capability is misplaced, stale, or invalid.",
	});
	return profiles;
}

function managedWhatsAppWebSocketUrl(controlPlaneApiUrl: string): string {
	const url = new URL(toWebSocketUrl(controlPlaneApiUrl));
	url.pathname = "/v1/channels/whatsapp/baileys";
	url.search = "";
	url.hash = "";
	return url.toString();
}

function linkProfileSuffix(linkId: string): string {
	return createHash("sha256").update(linkId).digest("hex").slice(0, 16);
}
