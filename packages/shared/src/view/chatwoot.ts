/** The signed-in Clerk user as a Chatwoot contact; identity validation hashes `id` server-side. */
export type ChatwootIdentity = Readonly<{
	id: string;
	name: string;
	email: string;
	avatarUrl?: string;
}>;

/** Support runs in English, and Chatwoot writes its system messages in the widget locale. */
export const CHATWOOT_LOCALE = "en";

function clean(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized || undefined;
}

// Chatwoot downloads the avatar server-side, so only https URLs are shared. A pattern rather than
// `URL.canParse`, which React Native's URL polyfill lacks.
function resolveAvatarUrl(imageUrl: string): string | undefined {
	const value = clean(imageUrl);
	return value && /^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(value) ? value : undefined;
}

export function resolveChatwootIdentity(user: {
	id: string;
	fullName: string | null;
	primaryEmailAddress: { emailAddress: string } | null;
	imageUrl: string;
}): ChatwootIdentity | null {
	const id = clean(user.id);
	const email = clean(user.primaryEmailAddress?.emailAddress);
	if (!id || !email) return null;
	const avatarUrl = resolveAvatarUrl(user.imageUrl);
	return {
		id,
		name: clean(user.fullName) ?? email,
		email,
		...(avatarUrl ? { avatarUrl } : {}),
	};
}
