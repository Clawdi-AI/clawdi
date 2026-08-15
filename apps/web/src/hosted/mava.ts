const MAVA_READY_EVENT = "loadMavaWebchat";
const MAVA_RETRY_DELAY_MS = 500;
const MAVA_RETRY_LIMIT = 30;

declare global {
	interface Window {
		Mava?: unknown;
		MavaWebChatToggle?: unknown;
	}
}

export type MavaIdentity = Readonly<{
	userId: string;
	emailAddress?: string;
	fullName?: string;
}>;

type MavaSdk = {
	initialize: () => unknown;
	identify: (identity: MavaIdentity) => unknown;
};

export type MavaIdentityController = {
	identify: (identity: MavaIdentity) => Promise<boolean>;
};

type MavaIdentitySyncOptions = {
	controller: MavaIdentityController;
	identity: MavaIdentity;
	retryDelayMs?: number;
	retryLimit?: number;
	subscribeReady?: (listener: () => void) => () => void;
	scheduleRetry?: (listener: () => void, delayMs: number) => () => void;
};

function normalizeIdentityValue(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function buildMavaIdentity({
	userId,
	emailAddress,
	fullName,
}: {
	userId: string | null | undefined;
	emailAddress: string | null | undefined;
	fullName: string | null | undefined;
}): MavaIdentity | null {
	const normalizedUserId = normalizeIdentityValue(userId);
	if (!normalizedUserId) return null;

	const normalizedEmailAddress = normalizeIdentityValue(emailAddress);
	const normalizedFullName = normalizeIdentityValue(fullName);
	return {
		userId: normalizedUserId,
		...(normalizedEmailAddress ? { emailAddress: normalizedEmailAddress } : {}),
		...(normalizedFullName ? { fullName: normalizedFullName } : {}),
	};
}

function isMavaSdk(value: unknown): value is MavaSdk {
	return (
		typeof value === "object" &&
		value !== null &&
		"initialize" in value &&
		typeof value.initialize === "function" &&
		"identify" in value &&
		typeof value.identify === "function"
	);
}

function identityKey(identity: MavaIdentity): string {
	return JSON.stringify([
		identity.userId,
		identity.emailAddress ?? null,
		identity.fullName ?? null,
	]);
}

function readConfiguredMavaSdk(): unknown {
	if (typeof window === "undefined" || typeof document === "undefined") return undefined;
	const widgetScript = document.getElementById("MavaWebChat");
	const token = widgetScript?.getAttribute("data-token")?.trim();
	return token ? window.Mava : undefined;
}

export function createMavaIdentityController(
	readSdk: () => unknown = readConfiguredMavaSdk,
): MavaIdentityController {
	let identifiedKey: string | null = null;
	let attemptInFlight = false;

	return {
		async identify(identity) {
			const nextIdentityKey = identityKey(identity);
			if (identifiedKey === nextIdentityKey) return true;
			if (attemptInFlight) return false;

			let sdk: unknown;
			try {
				sdk = readSdk();
			} catch {
				return false;
			}
			if (!isMavaSdk(sdk)) return false;

			attemptInFlight = true;
			try {
				await sdk.initialize();
				await sdk.identify(identity);
				identifiedKey = nextIdentityKey;
				return true;
			} catch {
				return false;
			} finally {
				attemptInFlight = false;
			}
		},
	};
}

export function subscribeToMavaReady(listener: () => void): () => void {
	window.addEventListener(MAVA_READY_EVENT, listener);
	return () => window.removeEventListener(MAVA_READY_EVENT, listener);
}

function readMavaWebChatToggle(): unknown {
	return typeof window === "undefined" ? undefined : window.MavaWebChatToggle;
}

export function toggleMavaWebChat(readToggle: () => unknown = readMavaWebChatToggle): boolean {
	try {
		const toggle = readToggle();
		if (typeof toggle !== "function") return false;
		toggle();
		return true;
	} catch {
		return false;
	}
}

export function requestMavaWebChatToggle({
	toggle = toggleMavaWebChat,
	retryDelayMs = MAVA_RETRY_DELAY_MS,
	retryLimit = MAVA_RETRY_LIMIT,
	subscribeReady = subscribeToMavaReady,
	scheduleRetry = scheduleBrowserRetry,
}: {
	toggle?: () => boolean;
	retryDelayMs?: number;
	retryLimit?: number;
	subscribeReady?: (listener: () => void) => () => void;
	scheduleRetry?: (listener: () => void, delayMs: number) => () => void;
} = {}): void {
	pendingMavaWebChatToggle?.();
	const boundedRetryLimit = Math.max(0, Math.floor(retryLimit));
	const boundedRetryDelayMs = Math.max(0, retryDelayMs);
	let stopped = false;
	let retryCount = 0;
	let cancelRetry: (() => void) | null = null;
	let unsubscribeReady = () => {};

	const stop = () => {
		if (stopped) return;
		stopped = true;
		unsubscribeReady();
		cancelRetry?.();
		cancelRetry = null;
		if (pendingMavaWebChatToggle === stop) pendingMavaWebChatToggle = null;
	};

	const attempt = () => {
		if (stopped) return;
		if (toggle()) {
			stop();
			return;
		}
		if (cancelRetry) return;
		if (retryCount >= boundedRetryLimit) {
			stop();
			return;
		}
		retryCount += 1;
		cancelRetry = scheduleRetry(() => {
			cancelRetry = null;
			attempt();
		}, boundedRetryDelayMs);
	};

	pendingMavaWebChatToggle = stop;
	unsubscribeReady = subscribeReady(attempt);
	if (stopped) unsubscribeReady();
	attempt();
}

let pendingMavaWebChatToggle: (() => void) | null = null;

function scheduleBrowserRetry(listener: () => void, delayMs: number): () => void {
	const timeoutId = window.setTimeout(listener, delayMs);
	return () => window.clearTimeout(timeoutId);
}

export function startMavaIdentitySync({
	controller,
	identity,
	retryDelayMs = MAVA_RETRY_DELAY_MS,
	retryLimit = MAVA_RETRY_LIMIT,
	subscribeReady = subscribeToMavaReady,
	scheduleRetry = scheduleBrowserRetry,
}: MavaIdentitySyncOptions): () => void {
	const boundedRetryLimit = Math.max(0, Math.floor(retryLimit));
	const boundedRetryDelayMs = Math.max(0, retryDelayMs);
	let stopped = false;
	let attemptInFlight = false;
	let retryCount = 0;
	let cancelRetry: (() => void) | null = null;
	let unsubscribeReady = () => {};

	const stop = () => {
		if (stopped) return;
		stopped = true;
		unsubscribeReady();
		cancelRetry?.();
		cancelRetry = null;
	};

	const scheduleNextRetry = () => {
		if (stopped || cancelRetry || retryCount >= boundedRetryLimit) return;
		retryCount += 1;
		cancelRetry = scheduleRetry(() => {
			cancelRetry = null;
			void attempt();
		}, boundedRetryDelayMs);
	};

	async function attempt() {
		if (stopped || attemptInFlight) return;
		attemptInFlight = true;
		const identified = await controller.identify(identity);
		attemptInFlight = false;
		if (stopped) return;
		if (identified) {
			stop();
			return;
		}
		scheduleNextRetry();
	}

	unsubscribeReady = subscribeReady(() => {
		void attempt();
	});
	void attempt();

	return stop;
}
