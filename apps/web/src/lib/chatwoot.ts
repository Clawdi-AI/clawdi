export type ChatwootIdentity = Readonly<{
	id: string;
	name: string;
	email: string;
}>;

export type ChatwootWidgetRequest = Readonly<{
	baseUrl: string;
	websiteToken: string;
	identity: ChatwootIdentity;
}>;

export type ChatwootWidgetSettings = Readonly<{
	position: "right";
	type: "standard";
	widgetStyle: "standard";
	darkMode: "auto";
	useBrowserLanguage: true;
}>;

const CHATWOOT_WIDGET_SETTINGS = {
	position: "right",
	type: "standard",
	widgetStyle: "standard",
	darkMode: "auto",
	useBrowserLanguage: true,
} as const satisfies ChatwootWidgetSettings;

export type ChatwootSdk = {
	run: (config: { websiteToken: string; baseUrl: string }) => unknown;
};

export type ChatwootApi = {
	setUser: (
		identifier: string,
		attributes: { name: string; email: string; identifier_hash: string },
	) => unknown;
	reset: () => unknown;
	toggleBubbleVisibility: (visibility: "hide" | "show") => unknown;
};

type ChatwootUser = {
	id: string;
	fullName: string | null;
	primaryEmailAddress: { emailAddress: string } | null;
};

type ChatwootControllerDependencies = {
	loadScript: (src: string) => Promise<void>;
	installSettings: (settings: ChatwootWidgetSettings) => void;
	readSdk: () => ChatwootSdk | undefined;
	readApi: () => ChatwootApi | undefined;
	subscribeReady: (listener: () => void) => void;
};

export type ChatwootWidgetController = {
	start: (
		request: ChatwootWidgetRequest,
		getIdentifierHash: () => Promise<string | null>,
	) => Promise<boolean>;
	cancel: () => void;
};

function clean(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function resolveChatwootWidgetRequest({
	baseUrl,
	websiteToken,
	desktopBuild,
	isLoaded,
	isSignedIn,
	user,
}: {
	baseUrl: string | undefined;
	websiteToken: string | undefined;
	desktopBuild: boolean;
	isLoaded: boolean;
	isSignedIn: boolean | undefined;
	user: ChatwootUser | null | undefined;
}): ChatwootWidgetRequest | null {
	const normalizedBaseUrl = clean(baseUrl)?.replace(/\/+$/, "");
	const normalizedWebsiteToken = clean(websiteToken);
	const id = clean(user?.id);
	const email = clean(user?.primaryEmailAddress?.emailAddress);
	if (
		desktopBuild ||
		!normalizedBaseUrl ||
		!normalizedWebsiteToken ||
		!isLoaded ||
		!isSignedIn ||
		!id ||
		!email
	) {
		return null;
	}

	return {
		baseUrl: normalizedBaseUrl,
		websiteToken: normalizedWebsiteToken,
		identity: {
			id,
			name: clean(user?.fullName) ?? email,
			email,
		},
	};
}

function requestKey(request: ChatwootWidgetRequest): string {
	return JSON.stringify([request.baseUrl, request.websiteToken]);
}

function identityKey(identity: ChatwootIdentity, identifierHash: string): string {
	return JSON.stringify([identity.id, identity.name, identity.email, identifierHash]);
}

export function createChatwootWidgetController({
	loadScript,
	installSettings,
	readSdk,
	readApi,
	subscribeReady,
}: ChatwootControllerDependencies): ChatwootWidgetController {
	let latestStart = 0;
	let initializationKey: string | null = null;
	let initialization: Promise<boolean> | null = null;
	let readySubscribed = false;
	let ready = false;
	let desiredIdentity: { identity: ChatwootIdentity; identifierHash: string } | null = null;
	let appliedIdentityKey: string | null = null;
	const identifierHashes = new Map<string, Promise<string | null>>();

	const applyIdentity = () => {
		if (!ready || !desiredIdentity) return;
		const api = readApi();
		if (!api) return;
		const nextIdentityKey = identityKey(desiredIdentity.identity, desiredIdentity.identifierHash);
		if (appliedIdentityKey === nextIdentityKey) return;
		api.setUser(desiredIdentity.identity.id, {
			name: desiredIdentity.identity.name,
			email: desiredIdentity.identity.email,
			identifier_hash: desiredIdentity.identifierHash,
		});
		api.toggleBubbleVisibility("show");
		appliedIdentityKey = nextIdentityKey;
	};

	const ensureReadySubscription = () => {
		if (readySubscribed) return;
		readySubscribed = true;
		subscribeReady(() => {
			ready = true;
			applyIdentity();
		});
	};

	const ensureInitialized = (request: ChatwootWidgetRequest): Promise<boolean> => {
		const nextInitializationKey = requestKey(request);
		if (initialization && initializationKey === nextInitializationKey) return initialization;
		if (initializationKey && initializationKey !== nextInitializationKey)
			return Promise.resolve(false);

		initializationKey = nextInitializationKey;
		const pending = loadScript(`${request.baseUrl}/packs/js/sdk.js`)
			.then(() => {
				const sdk = readSdk();
				if (!sdk) return false;
				installSettings(CHATWOOT_WIDGET_SETTINGS);
				sdk.run({ websiteToken: request.websiteToken, baseUrl: request.baseUrl });
				return true;
			})
			.catch(() => false);
		initialization = pending;
		void pending.then((initialized) => {
			if (!initialized && initialization === pending) {
				initialization = null;
				initializationKey = null;
			}
		});
		return pending;
	};

	return {
		cancel() {
			latestStart += 1;
			desiredIdentity = null;
			appliedIdentityKey = null;
			const api = readApi();
			if (api) {
				api.reset();
				api.toggleBubbleVisibility("hide");
			}
		},
		async start(request, getIdentifierHash) {
			const start = ++latestStart;
			let identifierHashPromise = identifierHashes.get(request.identity.id);
			if (!identifierHashPromise) {
				identifierHashPromise = getIdentifierHash().catch(() => null);
				identifierHashes.set(request.identity.id, identifierHashPromise);
			}
			const identifierHash = clean(await identifierHashPromise);
			if (!identifierHash || start !== latestStart) return false;

			desiredIdentity = { identity: request.identity, identifierHash };
			ensureReadySubscription();
			const initialized = await ensureInitialized(request);
			if (!initialized || start !== latestStart) return false;
			applyIdentity();
			return true;
		},
	};
}

const CHATWOOT_SCRIPT_ID = "clawdi-chatwoot-sdk";

declare global {
	interface Window {
		chatwootSDK?: ChatwootSdk;
		$chatwoot?: ChatwootApi;
		chatwootSettings?: ChatwootWidgetSettings;
	}
}

function loadChatwootScript(src: string): Promise<void> {
	if (window.chatwootSDK) return Promise.resolve();

	return new Promise((resolve, reject) => {
		const existing = document.getElementById(CHATWOOT_SCRIPT_ID) as HTMLScriptElement | null;
		const script = existing ?? document.createElement("script");
		const onLoad = () => {
			script.dataset.loaded = "true";
			resolve();
		};
		const onError = () => reject(new Error("Chatwoot SDK failed to load"));
		if (script.dataset.loaded === "true") {
			onLoad();
			return;
		}
		script.addEventListener("load", onLoad, { once: true });
		script.addEventListener("error", onError, { once: true });
		if (existing) return;

		script.id = CHATWOOT_SCRIPT_ID;
		script.src = src;
		script.async = true;
		script.defer = true;
		const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content.trim();
		if (nonce) script.nonce = nonce;
		document.head.appendChild(script);
	});
}

export const chatwootWidgetController = createChatwootWidgetController({
	loadScript: loadChatwootScript,
	installSettings: (settings) => {
		window.chatwootSettings = settings;
	},
	readSdk: () => window.chatwootSDK,
	readApi: () => window.$chatwoot,
	subscribeReady: (listener) => window.addEventListener("chatwoot:ready", listener),
});
