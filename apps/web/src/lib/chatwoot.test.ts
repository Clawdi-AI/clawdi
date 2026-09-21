import { describe, expect, mock, test } from "bun:test";
import {
	type ChatwootApi,
	type ChatwootSdk,
	type ChatwootWidgetSettings,
	createChatwootWidgetController,
	resolveChatwootWidgetRequest,
} from "@/lib/chatwoot";

const signedInUser = {
	id: "user_123",
	fullName: "Ada Lovelace",
	primaryEmailAddress: { emailAddress: "ada@example.com" },
};

describe("resolveChatwootWidgetRequest", () => {
	test("stays disabled without complete public configuration or in desktop builds", () => {
		expect(
			resolveChatwootWidgetRequest({
				baseUrl: undefined,
				websiteToken: "token",
				desktopBuild: false,
				isLoaded: true,
				isSignedIn: true,
				user: signedInUser,
			}),
		).toBeNull();
		expect(
			resolveChatwootWidgetRequest({
				baseUrl: "https://support.example.com",
				websiteToken: undefined,
				desktopBuild: false,
				isLoaded: true,
				isSignedIn: true,
				user: signedInUser,
			}),
		).toBeNull();
		expect(
			resolveChatwootWidgetRequest({
				baseUrl: "https://support.example.com",
				websiteToken: "token",
				desktopBuild: true,
				isLoaded: true,
				isSignedIn: true,
				user: signedInUser,
			}),
		).toBeNull();
	});

	test("stays disabled until Clerk has a signed-in user", () => {
		const configured = {
			baseUrl: "https://support.example.com",
			websiteToken: "token",
			desktopBuild: false,
		};
		expect(
			resolveChatwootWidgetRequest({
				...configured,
				isLoaded: false,
				isSignedIn: undefined,
				user: null,
			}),
		).toBeNull();
		expect(
			resolveChatwootWidgetRequest({
				...configured,
				isLoaded: true,
				isSignedIn: false,
				user: null,
			}),
		).toBeNull();
	});

	test("uses the Clerk id, full name, and primary email", () => {
		expect(
			resolveChatwootWidgetRequest({
				baseUrl: "https://support.example.com/",
				websiteToken: " token ",
				desktopBuild: false,
				isLoaded: true,
				isSignedIn: true,
				user: signedInUser,
			}),
		).toEqual({
			baseUrl: "https://support.example.com",
			websiteToken: "token",
			identity: {
				id: "user_123",
				name: "Ada Lovelace",
				email: "ada@example.com",
			},
		});
	});
});

describe("Chatwoot widget controller", () => {
	test("loads the SDK, initializes it, and sets the trusted user after readiness", async () => {
		let sdk: ChatwootSdk | undefined;
		let api: ChatwootApi | undefined;
		let readyListener: (() => void) | undefined;
		const initializationOrder: string[] = [];
		const installSettings = mock((settings: ChatwootWidgetSettings) => {
			initializationOrder.push("settings");
			expect(settings).toEqual({
				position: "right",
				type: "standard",
				widgetStyle: "standard",
				darkMode: "auto",
				useBrowserLanguage: true,
			});
		});
		const run = mock(() => {
			initializationOrder.push("run");
		});
		const setUser = mock(() => {});
		const reset = mock(() => {});
		const toggleBubbleVisibility = mock(() => {});
		const loadScript = mock(async (src: string) => {
			expect(src).toBe("https://support.example.com/packs/js/sdk.js");
			sdk = { run };
			api = { setUser, reset, toggleBubbleVisibility };
		});
		const getIdentifierHash = mock(async () => "trusted-hash");
		const controller = createChatwootWidgetController({
			loadScript,
			installSettings,
			readSdk: () => sdk,
			readApi: () => api,
			subscribeReady: (listener) => {
				readyListener = listener;
			},
		});
		const request = resolveChatwootWidgetRequest({
			baseUrl: "https://support.example.com",
			websiteToken: "token",
			desktopBuild: false,
			isLoaded: true,
			isSignedIn: true,
			user: signedInUser,
		});
		expect(request).not.toBeNull();
		if (!request) throw new Error("expected configured request");

		expect(await controller.start(request, getIdentifierHash)).toBe(true);
		expect(run).toHaveBeenCalledWith({
			websiteToken: "token",
			baseUrl: "https://support.example.com",
		});
		expect(installSettings).toHaveBeenCalledTimes(1);
		expect(initializationOrder).toEqual(["settings", "run"]);
		expect(setUser).not.toHaveBeenCalled();

		readyListener?.();
		expect(setUser).toHaveBeenCalledWith("user_123", {
			name: "Ada Lovelace",
			email: "ada@example.com",
			identifier_hash: "trusted-hash",
		});
		expect(toggleBubbleVisibility).toHaveBeenCalledWith("show");
	});

	test("survives the Strict Mode setup-cleanup-setup cycle", async () => {
		let resolveHash: ((hash: string) => void) | undefined;
		let readyListener: (() => void) | undefined;
		const installSettings = mock(() => {});
		const run = mock(() => {});
		const setUser = mock(() => {});
		const getIdentifierHash = mock(
			() =>
				new Promise<string>((resolve) => {
					resolveHash = resolve;
				}),
		);
		const controller = createChatwootWidgetController({
			loadScript: async () => {},
			installSettings,
			readSdk: () => ({ run }),
			readApi: () => ({
				setUser,
				reset: () => {},
				toggleBubbleVisibility: () => {},
			}),
			subscribeReady: (listener) => {
				readyListener = listener;
			},
		});
		const request = {
			baseUrl: "https://support.example.com",
			websiteToken: "token",
			identity: { id: "user_123", name: "Ada Lovelace", email: "ada@example.com" },
		};

		const firstStart = controller.start(request, getIdentifierHash);
		controller.cancel();
		const remountedStart = controller.start(request, getIdentifierHash);
		resolveHash?.("trusted-hash");

		expect(await firstStart).toBe(false);
		expect(await remountedStart).toBe(true);
		readyListener?.();
		expect(getIdentifierHash).toHaveBeenCalledTimes(1);
		expect(installSettings).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(1);
		expect(setUser).toHaveBeenCalledTimes(1);
	});

	test("prevents duplicate SDK initialization and identity calls across repeated starts", async () => {
		let readyListener: (() => void) | undefined;
		const run = mock(() => {});
		const setUser = mock(() => {});
		const reset = mock(() => {});
		const toggleBubbleVisibility = mock(() => {});
		const getIdentifierHash = mock(async () => "trusted-hash");
		const loadScript = mock(async () => {});
		const controller = createChatwootWidgetController({
			loadScript,
			installSettings: () => {},
			readSdk: () => ({ run }),
			readApi: () => ({ setUser, reset, toggleBubbleVisibility }),
			subscribeReady: (listener) => {
				readyListener = listener;
			},
		});
		const request = {
			baseUrl: "https://support.example.com",
			websiteToken: "token",
			identity: { id: "user_123", name: "Ada Lovelace", email: "ada@example.com" },
		};

		await Promise.all([
			controller.start(request, getIdentifierHash),
			controller.start(request, getIdentifierHash),
		]);
		readyListener?.();
		await controller.start(request, getIdentifierHash);

		expect(getIdentifierHash).toHaveBeenCalledTimes(1);
		expect(loadScript).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(1);
		expect(setUser).toHaveBeenCalledTimes(1);
	});

	test("clears trusted identity and hides the widget when the user signs out", async () => {
		let readyListener: (() => void) | undefined;
		const setUser = mock(() => {});
		const reset = mock(() => {});
		const toggleBubbleVisibility = mock(() => {});
		const controller = createChatwootWidgetController({
			loadScript: async () => {},
			installSettings: () => {},
			readSdk: () => ({ run: () => {} }),
			readApi: () => ({ setUser, reset, toggleBubbleVisibility }),
			subscribeReady: (listener) => {
				readyListener = listener;
			},
		});
		const request = {
			baseUrl: "https://support.example.com",
			websiteToken: "token",
			identity: { id: "user_123", name: "Ada Lovelace", email: "ada@example.com" },
		};

		await controller.start(request, async () => "trusted-hash");
		readyListener?.();
		controller.cancel();

		expect(reset).toHaveBeenCalledTimes(1);
		expect(toggleBubbleVisibility).toHaveBeenLastCalledWith("hide");

		await controller.start(request, async () => "trusted-hash");
		expect(setUser).toHaveBeenCalledTimes(2);
		expect(toggleBubbleVisibility).toHaveBeenLastCalledWith("show");
	});

	test("does not load the SDK when trusted identity validation is unavailable", async () => {
		const loadScript = mock(async () => {});
		const controller = createChatwootWidgetController({
			loadScript,
			installSettings: () => {},
			readSdk: () => undefined,
			readApi: () => undefined,
			subscribeReady: () => {},
		});

		expect(
			await controller.start(
				{
					baseUrl: "https://support.example.com",
					websiteToken: "token",
					identity: { id: "user_123", name: "Ada Lovelace", email: "ada@example.com" },
				},
				async () => null,
			),
		).toBe(false);
		expect(loadScript).not.toHaveBeenCalled();
	});

	test("cancels pending startup when the signed-in client unmounts", async () => {
		let resolveHash: ((hash: string) => void) | undefined;
		const loadScript = mock(async () => {});
		const controller = createChatwootWidgetController({
			loadScript,
			installSettings: () => {},
			readSdk: () => ({ run: () => {} }),
			readApi: () => undefined,
			subscribeReady: () => {},
		});
		const startup = controller.start(
			{
				baseUrl: "https://support.example.com",
				websiteToken: "token",
				identity: { id: "user_123", name: "Ada Lovelace", email: "ada@example.com" },
			},
			() =>
				new Promise<string>((resolve) => {
					resolveHash = resolve;
				}),
		);

		controller.cancel();
		resolveHash?.("trusted-hash");

		expect(await startup).toBe(false);
		expect(loadScript).not.toHaveBeenCalled();
	});
});
