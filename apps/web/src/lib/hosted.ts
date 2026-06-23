// Build-time flag, validated + parsed to boolean by `env`. See
// `hosted/README.md` and `v2/README.md` for bundle-boundary contracts.
import { env } from "@/lib/env";

export const IS_HOSTED: boolean = env.NEXT_PUBLIC_CLAWDI_HOSTED;
