import "../instrument.server.mjs";

import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { fetchWithWalletStripeReturnPolicy } from "@/lib/wallet-stripe-return";

const routerEntry = {
	fetch(request: Request) {
		return handler.fetch(request);
	},
};
const instrumentedEntry = process.env.VITE_SENTRY_DSN
	? wrapFetchWithSentry(routerEntry)
	: routerEntry;

export default createServerEntry({
	fetch(request: Request) {
		return fetchWithWalletStripeReturnPolicy(request, (cleanRequest) =>
			instrumentedEntry.fetch(cleanRequest),
		);
	},
});
