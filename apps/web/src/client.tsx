// Remove Stripe return secrets before telemetry modules evaluate.
import "./wallet-topup-return.bootstrap";

import "./instrument.client";

import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import "../instrumentation-client";

startTransition(() => {
	hydrateRoot(
		document,
		<StrictMode>
			<StartClient />
		</StrictMode>,
	);
});
