/** Development-only visual preview. Production bundles cannot enable this path. */
export function isMobilePreview() {
	return __DEV__ && process.env.EXPO_PUBLIC_MOBILE_PREVIEW === "1";
}
