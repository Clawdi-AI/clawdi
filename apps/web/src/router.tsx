import * as Sentry from "@sentry/tanstackstart-react";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const router = createRouter({
		routeTree,
		scrollRestoration: true,
		scrollToTopSelectors: ["#dashboard-scroll-container"],
	});

	if (!router.isServer && import.meta.env.VITE_SENTRY_DSN) {
		Sentry.addIntegration(Sentry.tanstackRouterBrowserTracingIntegration(router));
	}

	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
