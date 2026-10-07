import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";

/** M2 uses this policy for card-only surfaces, independently of IAP availability. */
export function isStoreBuild(config: Pick<MobileRuntimeConfig, "environment">): boolean {
	return config.environment === "production";
}
