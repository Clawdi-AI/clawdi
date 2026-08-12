import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cleanMarkedWalletTopupReturnRequest } from "@/lib/wallet-topup-return";

await import("../instrument.server.mjs");

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
		return instrumentedEntry.fetch(cleanMarkedWalletTopupReturnRequest(request));
	},
});
