import { stringifySetCookie } from "cookie";

export const TRIAL_OFFER_COOKIE = "clawdi-trial-offer";
const DESTINATIONS: Record<string, string> = {
	deploy: "/deploy",
	"sign-in": "/sign-in?redirect_url=%2Fdeploy",
	dashboard: "/",
};

// The hosted service owns credential validation and offer policy.
export function receiveTrialOffer(request: Request): Response {
	const url = new URL(request.url);
	const tokens = url.searchParams.getAll("token");
	const targets = url.searchParams.getAll("target");
	const profiles = url.searchParams.getAll("deploy_profile");
	const profile = profiles[0];
	const token = tokens[0];
	const target = targets[0];
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Referrer-Policy": "no-referrer",
	});
	if (
		tokens.length !== 1 ||
		targets.length !== 1 ||
		!token ||
		token.length > 512 ||
		/[^A-Za-z0-9._~-]/.test(token) ||
		!Object.hasOwn(DESTINATIONS, target) ||
		profiles.length > 1 ||
		(profiles.length === 1 &&
			(!profile || profile.length > 32 || !/^[a-z]/.test(profile) || /[^a-z0-9_-]/.test(profile)))
	)
		return new Response("Invalid trial offer", { status: 400, headers });
	const destination = new URL(DESTINATIONS[target], url.origin);
	if (profile) {
		if (target === "sign-in") {
			const deployment = new URL("/deploy", url.origin);
			deployment.searchParams.set("deploy_profile", profile);
			destination.searchParams.set("redirect_url", `${deployment.pathname}${deployment.search}`);
		} else destination.searchParams.set("deploy_profile", profile);
	}
	headers.set("Location", `${destination.pathname}${destination.search}`);
	headers.append(
		"Set-Cookie",
		stringifySetCookie({
			name: TRIAL_OFFER_COOKIE,
			value: token,
			httpOnly: true,
			secure: url.protocol === "https:",
			sameSite: "lax",
			path: "/",
		}),
	);
	return new Response(null, { status: 303, headers });
}
