import { env } from "@/lib/env";

/** Origin that publishes agent-facing files: the hosted marketing site, or this instance. */
export function publicSiteOrigin(instanceOrigin: string): string {
	return env.VITE_CLAWDI_HOSTED ? new URL(env.VITE_CLAWDI_MARKETING_URL).origin : instanceOrigin;
}
