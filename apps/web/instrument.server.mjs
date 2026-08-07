import * as Sentry from "@sentry/tanstackstart-react";

const dsn = process.env.VITE_SENTRY_DSN;

if (dsn) {
	Sentry.init({
		dsn,
		environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
		release: process.env.VERCEL_GIT_COMMIT_SHA,
		sendDefaultPii: false,
		tracesSampleRate: 0.1,
	});
}
