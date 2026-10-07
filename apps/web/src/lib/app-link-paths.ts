/** Only native association endpoints bypass Clerk and document nonce handling. */
export const APP_LINK_ASSOCIATION_PATHS: ReadonlySet<string> = new Set([
	"/.well-known/apple-app-site-association",
	"/.well-known/assetlinks.json",
]);
