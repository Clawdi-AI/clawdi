import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { installVitePreloadErrorRecovery } from "@/lib/vite-preload-recovery";
import { bootstrapWalletStripeReturnBeforeTelemetry } from "./wallet-stripe-return.bootstrap";

installVitePreloadErrorRecovery({ buildId: import.meta.url });

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
