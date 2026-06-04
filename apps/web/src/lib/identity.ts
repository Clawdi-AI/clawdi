/* Object identity: every project/vault gets a deterministic emoji + vivid
 * flat color derived from its name, so 100 objects never wear the same
 * folder icon (DESIGN.md decision 2026-06-03). Emoji here are object
 * AVATARS — the "no emoji as UI icons" rule still applies to controls. */

// Curated, work-flavored set — distinct silhouettes at small sizes.
const IDENTITY_EMOJI = [
	"🚀",
	"🔮",
	"🧪",
	"🌊",
	"🔥",
	"🌿",
	"⚡️",
	"🎯",
	"🧠",
	"🛠️",
	"🪐",
	"💎",
	"🍊",
	"🦊",
	"🌸",
	"🧭",
	"🎨",
	"📡",
	"📦",
	"🛰️",
	"🌋",
	"🐙",
	"🍀",
	"🎲",
	"🏔️",
	"🫐",
	"🌀",
	"🦉",
	"🍉",
	"🪴",
	"🧲",
	"🎈",
] as const;

// Static class strings so Tailwind's scanner sees every variant.
const IDENTITY_COLORS = [
	"bg-identity-1-bg text-identity-1-fg",
	"bg-identity-2-bg text-identity-2-fg",
	"bg-identity-3-bg text-identity-3-fg",
	"bg-identity-4-bg text-identity-4-fg",
	"bg-identity-5-bg text-identity-5-fg",
	"bg-identity-6-bg text-identity-6-fg",
	"bg-identity-7-bg text-identity-7-fg",
	"bg-identity-8-bg text-identity-8-fg",
] as const;

/** FNV-1a — stable across sessions and machines, no Math.random. */
function fnv1a(seed: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export interface ObjectIdentity {
	emoji: string;
	/** `bg-identity-N-bg text-identity-N-fg` — vivid flat tile colors. */
	colorClasses: string;
}

export function identityFor(seed: string | null | undefined): ObjectIdentity {
	const s = (seed ?? "").trim().toLowerCase() || "untitled";
	const h = fnv1a(s);
	return {
		emoji: IDENTITY_EMOJI[h % IDENTITY_EMOJI.length],
		// Use independent bits for the color so emoji/color combos vary.
		colorClasses: IDENTITY_COLORS[(h >>> 7) % IDENTITY_COLORS.length],
	};
}
