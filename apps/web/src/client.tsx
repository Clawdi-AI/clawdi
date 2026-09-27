import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { bootstrapWalletStripeReturnBeforeTelemetry } from "./wallet-stripe-return.bootstrap";

// A deploy replaces content-hashed chunks, so a tab opened before it can
// request modules that no longer exist. Reload into the current build once per
// missing module (the guard TanStack Router applies to lazy routes).
window.addEventListener("vite:preloadError", (event) => {
	const key = `clawdi:preload-reload:${event.payload.message}`;
	try {
		if (sessionStorage.getItem(key)) return;
		sessionStorage.setItem(key, "1");
	} catch {
		return;
	}
	window.location.reload();
});

async function startClient(): Promise<void> {
	await bootstrapWalletStripeReturnBeforeTelemetry();
	await Promise.allSettled([import("./instrument.client"), import("../instrumentation-client")]);

	startTransition(() => {
		hydrateRoot(
			document,
			<StrictMode>
				<StartClient />
			</StrictMode>,
		);
	});
}

void startClient();
