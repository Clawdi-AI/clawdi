import * as Sentry from "@sentry/tanstackstart-react";

const dsn = import.meta.env.VITE_SENTRY_DSN;

if (dsn && window.location.pathname !== "/vault-request") {
	Sentry.init({
		dsn,
		environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
		release: import.meta.env.VITE_SENTRY_RELEASE,
		sendDefaultPii: false,
		tracesSampleRate: 0.1,
		ignoreErrors: [
			// Page translators (Chrome/Edge translate, Youdao) replace React-owned
			// text nodes with <font> wrappers, so React's next commit fails with
			// these exact DOM errors (Chromium, then WebKit wording).
			/^NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node\.$/,
			/^NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node\.$/,
			/^NotFoundError: The object can not be found here\.$/,
			// Clerk's background session refresh lost the network; Clerk retries it.
			/^Error: ClerkJS: Network error at "[^"]+\/v1\/client\/sessions\/[^/"]+\/touch\?/,
		],
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
