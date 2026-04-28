// Build-time flag, validated + parsed to boolean by `env`. See
// `hosted/README.md` for the directory contract (data-hosted marker,
// no top-level side effects).
import { env } from "@/lib/env";

export const IS_HOSTED: boolean = env.NEXT_PUBLIC_CLAWDI_HOSTED;
