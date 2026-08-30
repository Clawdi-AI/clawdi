import {
	AnalyticsBrowser,
	type InboxAPI,
	type InboxMessage,
} from "@customerio/cdp-analytics-browser";
import { env } from "@/lib/env";

export type HostedCustomerIOIdentity = {
	email: string;
	userId: string;
	name: string | null;
};

let analytics: AnalyticsBrowser | null = null;
let analyticsReady: Promise<void> | null = null;
let identifiedAs: string | null = null;
const V2_INBOX_TOPIC = "clawdi_v2";

function customerIOClient(): { analytics: AnalyticsBrowser; ready: Promise<void> } | null {
	const writeKey = env.VITE_CUSTOMERIO_CDP_WRITE_KEY;
	if (!writeKey) return null;

	if (!analytics || !analyticsReady) {
		analytics = AnalyticsBrowser.load({ writeKey }, { initialPageview: true });
		analyticsReady = analytics.then(() => undefined);
	}

	return { analytics, ready: analyticsReady };
}

export async function syncHostedCustomerIOIdentity(
	identity: HostedCustomerIOIdentity | null,
): Promise<void> {
	const client = customerIOClient();
	if (!client) return;

	await client.ready;
	if (!identity) {
		if (identifiedAs !== null) await client.analytics.reset();
		identifiedAs = null;
		return;
	}

	const identityKey = `${identity.email}\n${identity.userId}\n${identity.name ?? ""}`;
	if (identifiedAs === identityKey) return;

	await client.analytics.identify(identity.email, {
		clerk_user_id: identity.userId,
		email: identity.email,
		name: identity.name ?? undefined,
	});
	identifiedAs = identityKey;
}

export async function getHostedCustomerIOInbox(
	identity: HostedCustomerIOIdentity,
): Promise<InboxAPI | null> {
	const client = customerIOClient();
	if (!client) return null;

	await syncHostedCustomerIOIdentity(identity);
	await client.ready;
	return client.analytics.inbox(V2_INBOX_TOPIC);
}

export type { InboxMessage };
