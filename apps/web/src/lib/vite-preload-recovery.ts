const RECOVERED_BUILD_KEY_PREFIX = "clawdi:vite-preload-recovered-build";

export interface VitePreloadErrorRecoveryRuntime {
	addEventListener(type: "vite:preloadError", listener: EventListener): void;
	removeEventListener(type: "vite:preloadError", listener: EventListener): void;
	sessionStorage: Pick<Storage, "getItem" | "setItem">;
	reload(): void;
}

function browserRuntime(): VitePreloadErrorRecoveryRuntime {
	return {
		addEventListener: window.addEventListener.bind(window),
		removeEventListener: window.removeEventListener.bind(window),
		get sessionStorage() {
			return window.sessionStorage;
		},
		reload: () => window.location.reload(),
	};
}

interface VitePreloadErrorRecoveryOptions {
	buildId?: string;
	runtime?: VitePreloadErrorRecoveryRuntime;
}

export function installVitePreloadErrorRecovery({
	buildId = import.meta.url,
	runtime = browserRuntime(),
}: VitePreloadErrorRecoveryOptions = {}): () => void {
	const recoveredBuildKey = `${RECOVERED_BUILD_KEY_PREFIX}:${buildId}`;
	const handlePreloadError: EventListener = (event) => {
		try {
			if (runtime.sessionStorage.getItem(recoveredBuildKey) === "1") return;
			runtime.sessionStorage.setItem(recoveredBuildKey, "1");
		} catch {
			return;
		}

		event.preventDefault();
		runtime.reload();
	};

	runtime.addEventListener("vite:preloadError", handlePreloadError);
	return () => runtime.removeEventListener("vite:preloadError", handlePreloadError);
}
