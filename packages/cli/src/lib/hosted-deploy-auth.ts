import {
	assertClerkOAuthEndpointProfile,
	getClawdiAccessToken,
	isClerkOAuthAuth,
} from "./clerk-oauth";
import { getAuth } from "./config";

const ACCESS_TOKEN_EXPIRY_SKEW_MS = 5_000;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const OAUTH_ACCESS_TOKEN_TYPES = new Set(["at+jwt", "application/at+jwt"]);

export type HostedDeployAccessToken = {
	token: string;
	expiresAt: string;
};

export interface HostedDeployAuthProvider {
	getAccessToken(): Promise<HostedDeployAccessToken>;
	invalidateAccessToken?(): Promise<void> | void;
}

export class HostedDeployAuthorizationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "HostedDeployAuthorizationError";
		this.code = code;
	}
}

function oauthHeaderType(token: string): string | null {
	const headerSegment = token.split(".")[0];
	if (!headerSegment) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const headerType = Reflect.get(parsed, "typ");
		return typeof headerType === "string" ? headerType : null;
	} catch {
		return null;
	}
}

export function assertHostedDeployAccessToken(
	credential: HostedDeployAccessToken,
	now = Date.now(),
): string {
	const token = credential.token.trim();
	if (token.startsWith("clawdi_")) {
		throw new HostedDeployAuthorizationError(
			"cloud_key_rejected",
			"A legacy Clawdi API key cannot authorize Hosted deployment. Run `clawdi auth login` without --manual.",
		);
	}
	if (
		!token ||
		token.length > 8_192 ||
		!JWT_PATTERN.test(token) ||
		!OAUTH_ACCESS_TOKEN_TYPES.has(oauthHeaderType(token) ?? "")
	) {
		throw new HostedDeployAuthorizationError(
			"invalid_hosted_token",
			"Hosted deployment requires a Clerk OAuth access token.",
		);
	}
	const expiresAt = Date.parse(credential.expiresAt);
	if (!Number.isFinite(expiresAt)) {
		throw new HostedDeployAuthorizationError(
			"invalid_hosted_token_expiry",
			"Clerk OAuth returned an invalid token expiry.",
		);
	}
	if (expiresAt <= now + ACCESS_TOKEN_EXPIRY_SKEW_MS) {
		throw new HostedDeployAuthorizationError(
			"hosted_token_expired",
			"Clerk OAuth access token expired. Run `clawdi auth login` again.",
		);
	}
	return token;
}

export type HostedDeployEndpointProfile = {
	cloudApiUrl: string;
	hostedApiUrl: string;
};

/** Reuses the single canonical Clerk OAuth session established by `clawdi auth login`. */
export function createHostedDeployAuthProvider(
	profile: HostedDeployEndpointProfile,
): HostedDeployAuthProvider {
	return {
		async getAccessToken() {
			const beforeRefresh = getAuth();
			if (!isClerkOAuthAuth(beforeRefresh)) {
				throw new HostedDeployAuthorizationError(
					"hosted_oauth_login_required",
					"Hosted deployment requires the canonical Clerk OAuth login. Run `clawdi auth login` without --manual.",
				);
			}
			try {
				assertClerkOAuthEndpointProfile(beforeRefresh, profile.cloudApiUrl, profile.hostedApiUrl);
			} catch {
				throw new HostedDeployAuthorizationError(
					"hosted_endpoint_binding_mismatch",
					"This Clerk OAuth login is not bound to the current Cloud and Hosted endpoints. Restore endpoint configuration or run `clawdi auth logout` followed by `clawdi auth login`.",
				);
			}
			const token = await getClawdiAccessToken(profile.cloudApiUrl);
			const refreshed = getAuth();
			if (!isClerkOAuthAuth(refreshed)) {
				throw new HostedDeployAuthorizationError(
					"hosted_oauth_login_required",
					"Clerk OAuth login is unavailable. Run `clawdi auth login` again.",
				);
			}
			try {
				assertClerkOAuthEndpointProfile(refreshed, profile.cloudApiUrl, profile.hostedApiUrl);
			} catch {
				throw new HostedDeployAuthorizationError(
					"hosted_endpoint_binding_mismatch",
					"The refreshed Clerk OAuth login is not bound to the current Cloud and Hosted endpoints. Run `clawdi auth login` again.",
				);
			}
			return { token, expiresAt: refreshed.accessTokenExpiresAt };
		},
	};
}
