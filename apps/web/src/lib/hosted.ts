// Build-time flag. Keep this as a direct import.meta.env comparison so Vite can
// fold IS_HOSTED-gated dynamic imports out of OSS bundles.
export const IS_HOSTED = import.meta.env.NEXT_PUBLIC_CLAWDI_HOSTED === "true";
