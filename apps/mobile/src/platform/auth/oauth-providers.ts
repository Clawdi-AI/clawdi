import type { OAuthProvider } from "@clerk/expo/types";

// Exhaustive against the installed SDK; this is a client vocabulary, not server enablement.
const providers: Record<Exclude<OAuthProvider, `custom_${string}`>, true> = {
	facebook: true,
	google: true,
	hubspot: true,
	github: true,
	tiktok: true,
	gitlab: true,
	discord: true,
	twitter: true,
	twitch: true,
	linkedin: true,
	linkedin_oidc: true,
	dropbox: true,
	atlassian: true,
	bitbucket: true,
	microsoft: true,
	notion: true,
	apple: true,
	line: true,
	instagram: true,
	coinbase: true,
	spotify: true,
	xero: true,
	box: true,
	slack: true,
	linear: true,
	x: true,
	enstall: true,
	huggingface: true,
	vercel: true,
	agentid: true,
};

function isProvider(value: string): value is OAuthProvider {
	return Object.hasOwn(providers, value) || /^custom_[a-z0-9_-]{1,100}$/.test(value);
}

export function readOAuthProviders(value: unknown): OAuthProvider[] {
	if (value == null || value === "") return [];
	if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid OAuth providers");
	const result: OAuthProvider[] = [];
	for (const item of value.split(",")) {
		const provider = item.trim();
		if (!isProvider(provider)) throw new Error("Invalid OAuth provider");
		if (!result.includes(provider)) result.push(provider);
	}
	if (result.length > 64) throw new Error("Too many OAuth providers");
	return result;
}

/**
 * App Review 4.8: iOS offers Sign in with Apple, through the native sheet,
 * whenever any third-party sign-in is offered. Other platforms keep the
 * configured browser OAuth list unchanged.
 */
export function socialSignInOptions(providers: readonly OAuthProvider[], os: string) {
	if (os !== "ios") return { nativeApple: false, oauth: [...providers] };
	return {
		nativeApple: providers.length > 0,
		oauth: providers.filter((provider) => provider !== "apple"),
	};
}
