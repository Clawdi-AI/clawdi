import { env } from "@/lib/env";
import { hostedApiBaseUrl } from "@/lib/hosted-url";

export const DEPLOY_API_URL = env.VITE_CLAWDI_DEPLOY_API_URL;

export { hostedApiBaseUrl };

/**
 * Whether the hosted backend can possibly be reached from this origin.
 *
 * `VITE_CLAWDI_DEPLOY_API_URL` defaults to the local hosted backend port. On a
 * non-localhost deployment that forgot to set it, every hosted fetch would be
 * dead on arrival; callers should skip hosted queries entirely.
 */
export function isDeployApiConfigured(): boolean {
	if (!DEPLOY_API_URL.includes("//localhost") && !DEPLOY_API_URL.includes("//127.0.0.1")) {
		return true;
	}
	if (typeof window === "undefined") return true;
	const host = window.location.hostname;
	return host === "localhost" || host === "127.0.0.1";
}
