const CAPTURE_KEY = "clawdi-deploy-intent";
export const DEPLOY_CHANNEL_TTL = 7 * 24 * 60 * 60 * 1000;
const BASE_ORIGIN = "https://clawdi.invalid";

function returnUrl(params: URLSearchParams): URL | null {
	const values = params.getAll("redirect_url");
	const value = values.length === 1 ? values[0] : undefined;
	if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
	try {
		const url = new URL(value, BASE_ORIGIN);
		return url.origin === BASE_ORIGIN ? url : null;
	} catch {
		return null;
	}
}

export function resolveDeployChannel(search: string): "sui" | null {
	const params = new URLSearchParams(search);
	const key = params.has("deploy_profile") ? "deploy_profile" : "utm_source";
	if (params.has(key)) {
		const values = params.getAll(key);
		return values.length === 1 && values[0] === "sui" ? "sui" : null;
	}
	const nested = returnUrl(params);
	if (!nested) return null;
	const nestedKey = nested.searchParams.has("deploy_profile") ? "deploy_profile" : "utm_source";
	const values = nested.searchParams.getAll(nestedKey);
	return values.length === 1 && values[0] === "sui" ? "sui" : null;
}

export function clearDeployChannelUrl(href: string): string {
	const url = new URL(href, BASE_ORIGIN);
	const clear = (params: URLSearchParams) => {
		if (params.get("deploy_profile") === "sui") params.delete("deploy_profile");
		if (params.get("utm_source") === "sui") params.delete("utm_source");
	};
	clear(url.searchParams);
	const nested = returnUrl(url.searchParams);
	if (nested) {
		clear(nested.searchParams);
		url.searchParams.set("redirect_url", `${nested.pathname}${nested.search}${nested.hash}`);
	}
	return `${url.pathname}${url.search}${url.hash}`;
}

type Intent = { channel: "sui"; capturedAt: number; userId: string | null };
type Snapshot = { intent: Intent | null; error: boolean };
const EMPTY: Snapshot = { intent: null, error: false };

// One browser owner. Storage is an optional reload transport, never account truth.
export class DeployChannelIntent {
	private snapshot: Snapshot = EMPTY;
	private initialized = false;
	private listeners = new Set<() => void>();
	private flight:
		| { intent: Intent; promise: Promise<void>; controller: AbortController }
		| undefined;

	constructor(private storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">) {}

	getSnapshot = (): Snapshot => this.snapshot;
	getServerSnapshot = (): Snapshot => EMPTY;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private publish(intent: Intent | null, error = false): void {
		if (this.flight && this.flight.intent !== intent) this.flight.controller.abort();
		this.snapshot = { intent, error };
		try {
			if (intent) this.storage().setItem(CAPTURE_KEY, JSON.stringify(intent));
			else this.storage().removeItem(CAPTURE_KEY);
		} catch {
			// Current-page and auth-return URLs still work without browser storage.
		}
		for (const listener of this.listeners) listener();
	}

	capture(search: string, userId: string | null, now = Date.now()): boolean {
		if (!this.initialized) {
			this.initialized = true;
			try {
				const value: unknown = JSON.parse(this.storage().getItem(CAPTURE_KEY) ?? "null");
				if (
					value &&
					typeof value === "object" &&
					"channel" in value &&
					value.channel === "sui" &&
					"capturedAt" in value &&
					typeof value.capturedAt === "number" &&
					"userId" in value &&
					(value.userId === null || typeof value.userId === "string")
				) {
					this.publish({ channel: "sui", capturedAt: value.capturedAt, userId: value.userId });
				}
			} catch {
				// Malformed or unavailable storage does not prevent URL capture.
			}
		}
		let intent = this.snapshot.intent;
		if (intent && (intent.capturedAt > now || now - intent.capturedAt >= DEPLOY_CHANNEL_TTL)) {
			this.publish(null);
			intent = null;
		}
		// A different signed-in account discards the old claim and its URL; never reassign it.
		if (intent?.userId && intent.userId !== userId) {
			if (userId) {
				this.publish(null);
				return true;
			}
			return false;
		}
		if (!intent && resolveDeployChannel(search)) {
			intent = { channel: "sui", capturedAt: now, userId };
			this.publish(intent);
		} else if (intent && !intent.userId && userId) {
			this.publish({ ...intent, userId });
		}
		return false;
	}

	claim(userId: string, save: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const intent = this.snapshot.intent;
		if (!intent || intent.userId !== userId) return Promise.resolve();
		if (this.flight?.intent === intent) return this.flight.promise;
		const controller = new AbortController();
		const promise = Promise.resolve()
			.then(() => {
				controller.signal.throwIfAborted();
				return save(controller.signal);
			})
			.then(() => {
				if (this.snapshot.intent === intent) this.publish(null);
			})
			.catch(() => {
				if (this.snapshot.intent === intent) this.publish(intent, true);
			})
			.finally(() => {
				if (this.flight?.intent === intent) this.flight = undefined;
			});
		this.flight = { intent, promise, controller };
		return promise;
	}
}

export const deployChannelIntent = new DeployChannelIntent(() => window.sessionStorage);
