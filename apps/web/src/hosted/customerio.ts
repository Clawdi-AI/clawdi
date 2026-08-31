import {
	AnalyticsBrowser,
	type InboxAPI,
	type InboxMessage,
} from "@customerio/cdp-analytics-browser";
import { env } from "@/lib/env";

export type HostedCustomerIOIdentity = {
	customerId: string;
	clerkId: string;
	email: string;
	name: string | null;
};

export type CustomerIORegion = "us" | "eu";

type CustomerIOBrowserSettings = {
	writeKey: string;
	cdnURL?: string;
};

type CustomerIOAnalytics = {
	identify: (customerId: string, traits: Record<string, string | undefined>) => unknown;
	reset: () => unknown;
	inbox: (topic: string) => InboxAPI;
};

type LoadedCustomerIO = {
	analytics: CustomerIOAnalytics;
	ready: Promise<void>;
};

type CustomerIOLoader = (
	settings: CustomerIOBrowserSettings,
	options: { initialPageview: false },
) => LoadedCustomerIO;

const V2_INBOX_TOPIC = "clawdi_v2";
const CUSTOMERIO_EU_CDN_URL = "https://cdp-eu.customer.io";

export function customerIOBrowserSettings(
	writeKey: string,
	region: CustomerIORegion,
): CustomerIOBrowserSettings {
	return region === "eu" ? { writeKey, cdnURL: CUSTOMERIO_EU_CDN_URL } : { writeKey };
}

const loadCustomerIO: CustomerIOLoader = (settings, options) => {
	const analytics = AnalyticsBrowser.load(settings, options);
	return { analytics, ready: analytics.then(() => undefined) };
};

export function createHostedCustomerIOController(
	config: { writeKey?: string; region: CustomerIORegion },
	load: CustomerIOLoader = loadCustomerIO,
) {
	let client: LoadedCustomerIO | null = null;
	let identifiedAs: string | null = null;
	let identityQueue: Promise<void> = Promise.resolve();

	function customerIOClient(): LoadedCustomerIO | null {
		if (!config.writeKey) return null;
		if (client) return client;

		const loaded = load(customerIOBrowserSettings(config.writeKey, config.region), {
			initialPageview: false,
		});
		const ready = loaded.ready.catch((error: unknown) => {
			if (client?.analytics === loaded.analytics) {
				client = null;
				identifiedAs = null;
			}
			throw error;
		});
		client = { analytics: loaded.analytics, ready };
		return client;
	}

	async function applyIdentity(identity: HostedCustomerIOIdentity | null): Promise<void> {
		const current = customerIOClient();
		if (!current) return;

		await current.ready;
		if (!identity) {
			if (identifiedAs !== null) await current.analytics.reset();
			identifiedAs = null;
			return;
		}

		const identityKey = [
			identity.customerId,
			identity.clerkId,
			identity.email,
			identity.name ?? "",
		].join("\n");
		if (identifiedAs === identityKey) return;

		await current.analytics.identify(identity.customerId, {
			clerk_id: identity.clerkId,
			email: identity.email,
			name: identity.name ?? undefined,
		});
		identifiedAs = identityKey;
	}

	function syncIdentity(identity: HostedCustomerIOIdentity | null): Promise<void> {
		const operation = identityQueue.then(() => applyIdentity(identity));
		identityQueue = operation.catch(() => undefined);
		return operation;
	}

	async function getInbox(identity: HostedCustomerIOIdentity): Promise<InboxAPI | null> {
		await syncIdentity(identity);
		const current = customerIOClient();
		if (!current) return null;
		await current.ready;
		return current.analytics.inbox(V2_INBOX_TOPIC);
	}

	return { getInbox, syncIdentity };
}

export function resolveHostedNotificationUrl(
	value: string,
	origin: string,
): { kind: "same-origin" | "external"; url: URL } | null {
	try {
		const base = new URL(origin);
		const url = new URL(value, base);
		if (url.origin === base.origin) return { kind: "same-origin", url };
		return url.protocol === "https:" ? { kind: "external", url } : null;
	} catch {
		return null;
	}
}

const hostedCustomerIO = createHostedCustomerIOController({
	writeKey: env.VITE_CUSTOMERIO_CDP_WRITE_KEY,
	region: env.VITE_CUSTOMERIO_CDP_REGION,
});

export const syncHostedCustomerIOIdentity = hostedCustomerIO.syncIdentity;
export const getHostedCustomerIOInbox = hostedCustomerIO.getInbox;

export type { InboxMessage };
