import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { captureDeployChannel } from "./lib/deploy-channel";
import { bootstrapWalletStripeReturnBeforeTelemetry } from "./wallet-stripe-return.bootstrap";

async function startClient(): Promise<void> {
	captureDeployChannel();
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
