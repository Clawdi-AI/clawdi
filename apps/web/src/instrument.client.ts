import * as Sentry from "@sentry/tanstackstart-react";

const dsn = import.meta.env.VITE_SENTRY_DSN;

if (dsn && window.location.pathname !== "/vault-request") {
	Sentry.init({
		dsn,
		environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
		release: import.meta.env.VITE_SENTRY_RELEASE,
		sendDefaultPii: false,
		tracesSampleRate: 0.1,
		beforeSend: (event) => (window.location.pathname === "/vault-request" ? null : event),
		beforeSendTransaction: (event) =>
			window.location.pathname === "/vault-request" ? null : event,
		beforeBreadcrumb: (breadcrumb) =>
			[breadcrumb.data?.from, breadcrumb.data?.to].some(
				(value) => typeof value === "string" && value.includes("/vault-request"),
			)
				? null
				: breadcrumb,
	});
}
