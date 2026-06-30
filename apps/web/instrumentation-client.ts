const IS_HOSTED = import.meta.env.VITE_CLAWDI_HOSTED === "true";

const initHostedPostHog = IS_HOSTED
	? () => import("@/hosted/posthog").then((m) => m.initHostedPostHog())
	: null;

if (initHostedPostHog) {
	void initHostedPostHog();
}
