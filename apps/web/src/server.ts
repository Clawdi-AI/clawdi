import "../instrument.server.mjs";

import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";

const serverEntry = {
	fetch(request: Request) {
		return handler.fetch(request);
	},
};

export default createServerEntry(
	process.env.VITE_SENTRY_DSN ? wrapFetchWithSentry(serverEntry) : serverEntry,
);
