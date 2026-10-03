import { createHmac, timingSafeEqual } from "node:crypto";
import { DEPLOY_CHANNELS, type DeployChannelId } from "@/lib/deploy-channel";

export const CHANNEL_ATTRIBUTION_COOKIE = "__Host-clawdi-channel-attribution";
const TOKEN_TTL_SECONDS = 15 * 60;
const TOKEN_PATTERN =
	/^v1\.([a-z][a-z0-9_-]{0,31})\.([1-9][0-9]{0,10})\.([1-9][0-9]{0,10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export function verifyChannelAttribution(
	token: string | null | undefined,
	secret: string | undefined,
	now = Math.floor(Date.now() / 1000),
): { channel: DeployChannelId; expiresAt: number; token: string } | null {
	if (!token || !secret || Buffer.byteLength(secret) < 32 || token.length > 512) return null;
	const match = TOKEN_PATTERN.exec(token);
	if (!match || match[0] !== token) return null;
	const [, channel, issuedRaw, expiresRaw, nonce, signature] = match;
	if (!channel || !issuedRaw || !expiresRaw || !nonce || !signature) return null;
	const config = Object.values(DEPLOY_CHANNELS).find((entry) => entry.id === channel);
	if (!config) return null;
	const issued = Number(issuedRaw);
	const expiresAt = Number(expiresRaw);
	if (expiresAt - issued !== TOKEN_TTL_SECONDS || issued > now + 60 || expiresAt <= now)
		return null;
	const message = `clawdi/channel-trial/v1|${channel}|${issued}|${expiresAt}|${nonce}`;
	const expected = createHmac("sha256", secret).update(message).digest("base64url");
	if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
	return { channel: config.id, expiresAt, token };
}

/** Exchange the signed link for an HttpOnly cookie before rendering any app scripts. */
export function captureChannelAttribution(request: Request, channel: string): Response {
	const url = new URL(request.url);
	const tokens = url.searchParams.getAll("token");
	const targets = url.searchParams.getAll("target");
	const attribution =
		tokens.length === 1
			? verifyChannelAttribution(tokens[0], process.env.CHANNEL_ATTRIBUTION_SECRET)
			: null;
	const target = targets.length === 0 ? "deploy" : targets.length === 1 ? targets[0] : null;
	const destination =
		target === "deploy"
			? "/deploy"
			: target === "sign-in"
				? "/sign-in?redirect_url=%2Fdeploy"
				: target === "dashboard"
					? "/"
					: null;
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Referrer-Policy": "no-referrer",
	});
	if (!attribution || attribution.channel !== channel || !destination) {
		return new Response(
			"This trial invitation is invalid or expired. Request a new Sui invitation.",
			{
				status: 400,
				headers,
			},
		);
	}
	const maxAge = attribution.expiresAt - Math.floor(Date.now() / 1000);
	headers.set(
		"Set-Cookie",
		`${CHANNEL_ATTRIBUTION_COOKIE}=${attribution.token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
	);
	headers.set("Location", destination);
	return new Response(null, { status: 303, headers });
}
