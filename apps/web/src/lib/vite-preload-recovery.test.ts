import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	installVitePreloadErrorRecovery,
	type VitePreloadErrorRecoveryRuntime,
} from "@/lib/vite-preload-recovery";

function createRuntime() {
	const values = new Map<string, string>();
	let handler: EventListener | null = null;
	const reload = mock(() => {});
	const runtime: VitePreloadErrorRecoveryRuntime = {
		addEventListener: (_type, listener) => {
			handler = listener;
		},
		removeEventListener: (_type, listener) => {
			if (handler === listener) handler = null;
		},
		sessionStorage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => values.set(key, value),
		},
		reload,
	};
	return {
		runtime,
		reload,
		dispatch(message: string) {
			const event = new Event("vite:preloadError", { cancelable: true });
			Object.assign(event, { payload: new TypeError(message) });
			handler?.(event);
			return event;
		},
		hasHandler: () => handler !== null,
	};
}

describe("Vite preload error recovery", () => {
	test("reloads once for a stale chunk and suppresses the handled error", () => {
		const { runtime, reload, dispatch } = createRuntime();
		installVitePreloadErrorRecovery({ runtime });

		const first = dispatch(
			"Failed to fetch dynamically imported module: https://cloud.clawdi.ai/assets/chatwoot-old.js",
		);
		const repeated = dispatch(
			"Failed to fetch dynamically imported module: https://cloud.clawdi.ai/assets/chatwoot-old.js",
		);

		expect(reload).toHaveBeenCalledTimes(1);
		expect(first.defaultPrevented).toBe(true);
		expect(repeated.defaultPrevented).toBe(false);
	});

	test("uses one recovery reload budget for the current client build", () => {
		const { runtime, reload, dispatch } = createRuntime();
		installVitePreloadErrorRecovery({ runtime });

		for (let index = 0; index < 21; index += 1) {
			dispatch(`Failed to fetch dynamically imported module: /assets/chunk-${index}.js`);
		}
		dispatch("Failed to fetch dynamically imported module: /assets/chunk-0.js");

		expect(reload).toHaveBeenCalledTimes(1);
	});

	test("allows each exact client build to recover once across build switches", () => {
		const { runtime, reload, dispatch } = createRuntime();
		const uninstallFirstBuild = installVitePreloadErrorRecovery({
			buildId: "build-a",
			runtime,
		});
		dispatch("Failed to fetch dynamically imported module: /assets/chunk-a.js");
		uninstallFirstBuild();

		const uninstallSecondBuild = installVitePreloadErrorRecovery({
			buildId: "build-b",
			runtime,
		});
		dispatch("Failed to fetch dynamically imported module: /assets/chunk-b.js");
		uninstallSecondBuild();

		installVitePreloadErrorRecovery({ buildId: "build-a", runtime });
		dispatch("Failed to fetch dynamically imported module: /assets/chunk-a.js");

		expect(reload).toHaveBeenCalledTimes(2);
	});

	test("installs safely when the browser blocks session storage access", () => {
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				addEventListener: () => {},
				removeEventListener: () => {},
				get sessionStorage() {
					throw new DOMException("storage blocked", "SecurityError");
				},
				location: { reload: () => {} },
			},
		});
		try {
			expect(() => installVitePreloadErrorRecovery()).not.toThrow();
		} finally {
			if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
			else Reflect.deleteProperty(globalThis, "window");
		}
	});

	test("leaves the error untouched when session storage cannot guard against a reload loop", () => {
		const { runtime, reload, dispatch } = createRuntime();
		runtime.sessionStorage.getItem = () => {
			throw new Error("storage disabled");
		};
		installVitePreloadErrorRecovery({ runtime });

		const event = dispatch("Failed to fetch dynamically imported module: /assets/chatwoot-old.js");

		expect(reload).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	test("leaves the error untouched when the recovery marker cannot be written", () => {
		const { runtime, reload, dispatch } = createRuntime();
		runtime.sessionStorage.setItem = () => {
			throw new DOMException("quota exceeded", "QuotaExceededError");
		};
		installVitePreloadErrorRecovery({ runtime });

		const event = dispatch("preload failed");

		expect(reload).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	test("installs recovery before client bootstrap can request dynamic chunks", () => {
		const clientSource = readFileSync(join(import.meta.dir, "../client.tsx"), "utf8");
		const installIndex = clientSource.indexOf(
			"installVitePreloadErrorRecovery({ buildId: import.meta.url })",
		);
		const bootstrapIndex = clientSource.indexOf("bootstrapWalletStripeReturnBeforeTelemetry()");

		expect(installIndex).toBeGreaterThanOrEqual(0);
		expect(installIndex).toBeLessThan(bootstrapIndex);
	});

	test("removes the listener during teardown", () => {
		const { runtime, hasHandler } = createRuntime();
		const uninstall = installVitePreloadErrorRecovery({ runtime });
		expect(hasHandler()).toBe(true);

		uninstall();
		expect(hasHandler()).toBe(false);
	});
});
