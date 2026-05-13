const initHostedPostHog =
	process.env.NEXT_PUBLIC_CLAWDI_HOSTED === "true"
		? () => import("@/hosted/posthog").then((m) => m.initHostedPostHog())
		: null;

if (initHostedPostHog) {
	void initHostedPostHog();
}
