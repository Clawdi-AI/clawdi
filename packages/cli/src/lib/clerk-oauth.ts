import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
	type ClawdiAuth,
	type ClerkOAuthAuth,
	clearAuth,
	clearPendingAuth,
	getAuth,
	getClawdiDir,
	getPendingAuth,
	getStoredAuth,
	type PendingAuth,
	setAuth,
	setPendingAuth,
} from "./config";
import {
	type PrivateDirectoryLockOptions,
	withPrivateDirectoryLock,
} from "./private-directory-lock";

const REQUEST_TIMEOUT_MS = 20_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const OAUTH_LOGIN_TTL_MS = 10 * 60_000;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const OAUTH_ACCESS_TOKEN_TYPES = new Set(["at+jwt", "application/at+jwt"]);
const REQUIRED_DISCOVERY_GRANTS = ["authorization_code", "refresh_token"] as const;
const REQUIRED_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export type ClerkOAuthClientConfig = {
	issuer: string;
	clientId: string;
	audience: string;
	authorizedParties: string[];
	redirectUri: string;
};

export type ClerkOAuthDiscovery = {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
};

export class ClerkOAuthError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ClerkOAuthError";
		this.code = code;
	}
}

type FetchLike = (request: Request) => Promise<Response>;

export type ClerkOAuthNetworkOptions = {
	fetch?: FetchLike;
	now?: () => number;
	refreshLock?: PrivateDirectoryLockOptions;
};

export type ClerkOAuthCloudUser = {
	id: string;
	email?: string;
	name?: string;
};

export type ClerkOAuthCloudVerification =
	| { kind: "verified"; user: ClerkOAuthCloudUser }
	| {
			kind: "cloud_unverified";
			reason: "network" | "server_error";
			httpStatus?: number;
	  };

export type StoredCredentialIdentity =
	| { kind: "none" }
	| { kind: "legacy_api_key"; digest: string }
	| { kind: "clerk_oauth"; subject: string };

export type CredentialLogoutResult = {
	loggedOut: boolean;
	remoteRevoked: boolean;
	environmentCredential: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength = 8_192): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value.trim();
	return cleaned && cleaned.length <= maxLength ? cleaned : null;
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
	return value.map((item) => item.trim()).filter(Boolean);
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
	try {
		const decoded = Buffer.from(segment, "base64url").toString("utf8");
		const parsed: unknown = JSON.parse(decoded);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function oauthJwtParts(token: string): {
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
} | null {
	if (!JWT_PATTERN.test(token)) return null;
	const [headerSegment, payloadSegment] = token.split(".");
	if (!headerSegment || !payloadSegment) return null;
	const header = base64UrlJson(headerSegment);
	const payload = base64UrlJson(payloadSegment);
	return header && payload ? { header, payload } : null;
}

function validCanonicalHostname(hostname: string): boolean {
	if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
	return hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function exactIssuer(raw: string): string {
	const trimmed = raw.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new ClerkOAuthError("invalid_oauth_config", "Clawdi OAuth issuer is invalid.");
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]" ||
		url.hostname === "::1";
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		!validCanonicalHostname(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		trimmed.includes("?") ||
		trimmed.includes("#")
	) {
		throw new ClerkOAuthError("invalid_oauth_config", "Clawdi OAuth issuer must be a secure URL.");
	}
	return url.toString().replace(/\/$/, "");
}

function exactIssuerEndpoint(raw: string, issuer: string, label: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ClerkOAuthError("invalid_oauth_discovery", `Clerk ${label} is invalid.`);
	}
	const issuerUrl = new URL(issuer);
	if (
		url.origin !== issuerUrl.origin ||
		url.protocol !== issuerUrl.protocol ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new ClerkOAuthError(
			"invalid_oauth_discovery",
			`Clerk ${label} does not match the configured issuer.`,
		);
	}
	return url.toString();
}

function exactAuthorizedParty(raw: string): string {
	const trimmed = raw.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new ClerkOAuthError("invalid_oauth_config", "Clawdi OAuth authorized party is invalid.");
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]" ||
		url.hostname === "::1";
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		!validCanonicalHostname(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		trimmed.includes("?") ||
		trimmed.includes("#")
	) {
		throw new ClerkOAuthError(
			"invalid_oauth_config",
			"Clawdi OAuth authorized party must be a secure origin.",
		);
	}
	return url.origin;
}

function exactLoopbackRedirectUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ClerkOAuthError("invalid_oauth_config", "Clawdi OAuth redirect URI is invalid.");
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]" ||
		url.hostname === "::1";
	if (
		url.protocol !== "http:" ||
		!loopback ||
		!url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/oauth/callback"
	) {
		throw new ClerkOAuthError(
			"invalid_oauth_config",
			"Clawdi OAuth redirect URI must be a registered loopback /oauth/callback URL.",
		);
	}
	return url.toString();
}

async function fetchWithTimeout(request: Request): Promise<Response> {
	const controller = new AbortController();
	const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(request, { signal: controller.signal });
	} catch {
		throw new ClerkOAuthError(
			"oauth_network_error",
			"Could not reach Clawdi authentication. Check your connection and retry.",
		);
	} finally {
		globalThis.clearTimeout(timeout);
	}
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new ClerkOAuthError(
			"invalid_oauth_response",
			"Authentication returned an invalid response.",
		);
	}
}

export async function fetchClerkOAuthClientConfig(
	apiUrl: string,
	options: ClerkOAuthNetworkOptions = {},
): Promise<ClerkOAuthClientConfig> {
	const fetcher = options.fetch ?? fetchWithTimeout;
	const endpoint = new URL("/v1/cli/auth/oauth/config", `${apiUrl.replace(/\/$/, "")}/`);
	const response = await fetcher(
		new Request(endpoint, { headers: { Accept: "application/json" } }),
	);
	if (!response.ok) {
		throw new ClerkOAuthError(
			"oauth_not_configured",
			"Clawdi OAuth login is not configured. Use `clawdi auth login --manual` only for legacy API-key compatibility.",
		);
	}
	const body = await readJson(response);
	if (!isRecord(body)) {
		throw new ClerkOAuthError("invalid_oauth_config", "Clawdi returned invalid OAuth settings.");
	}
	const issuer = nonEmptyString(body.issuer, 2_048);
	const clientId = nonEmptyString(body.client_id, 512);
	const audience = typeof body.audience === "string" ? body.audience.trim() : null;
	const authorizedParties =
		body.authorized_parties === undefined ? [] : stringArray(body.authorized_parties);
	const redirectUri = nonEmptyString(body.redirect_uri, 2_048);
	if (
		!issuer ||
		!clientId ||
		audience === null ||
		audience.length > 512 ||
		!authorizedParties ||
		!redirectUri
	) {
		throw new ClerkOAuthError("invalid_oauth_config", "Clawdi returned incomplete OAuth settings.");
	}
	return {
		issuer: exactIssuer(issuer),
		clientId,
		audience,
		authorizedParties: authorizedParties.map(exactAuthorizedParty),
		redirectUri: exactLoopbackRedirectUri(redirectUri),
	};
}

export async function fetchClerkOAuthDiscovery(
	config: ClerkOAuthClientConfig,
	options: ClerkOAuthNetworkOptions = {},
): Promise<ClerkOAuthDiscovery> {
	const fetcher = options.fetch ?? fetchWithTimeout;
	const discoveryUrl = new URL(
		`${config.issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
	);
	const response = await fetcher(
		new Request(discoveryUrl, { headers: { Accept: "application/json" } }),
	);
	if (!response.ok) {
		throw new ClerkOAuthError(
			"oauth_discovery_unavailable",
			"Could not load Clerk OAuth discovery metadata.",
		);
	}
	const body = await readJson(response);
	if (!isRecord(body)) {
		throw new ClerkOAuthError(
			"invalid_oauth_discovery",
			"Clerk returned invalid OAuth discovery metadata.",
		);
	}
	const issuer = nonEmptyString(body.issuer, 2_048);
	const authorizationEndpoint = nonEmptyString(body.authorization_endpoint, 2_048);
	const tokenEndpoint = nonEmptyString(body.token_endpoint, 2_048);
	const grants = stringArray(body.grant_types_supported);
	const challenges = stringArray(body.code_challenge_methods_supported);
	const tokenAuthMethods = stringArray(body.token_endpoint_auth_methods_supported);
	if (
		!issuer ||
		exactIssuer(issuer) !== config.issuer ||
		!authorizationEndpoint ||
		!tokenEndpoint ||
		!grants ||
		!REQUIRED_DISCOVERY_GRANTS.every((grant) => grants.includes(grant)) ||
		!challenges?.includes("S256") ||
		!tokenAuthMethods?.includes("none")
	) {
		throw new ClerkOAuthError(
			"invalid_oauth_discovery",
			"Clerk OAuth discovery does not support the required public-client PKCE contract.",
		);
	}
	return {
		issuer: config.issuer,
		authorizationEndpoint: exactIssuerEndpoint(
			authorizationEndpoint,
			config.issuer,
			"authorization endpoint",
		),
		tokenEndpoint: exactIssuerEndpoint(tokenEndpoint, config.issuer, "token endpoint"),
	};
}

export function createClerkOAuthAuthorization({
	config,
	discovery,
	apiUrl,
	now = Date.now,
}: {
	config: ClerkOAuthClientConfig;
	discovery: ClerkOAuthDiscovery;
	apiUrl: string;
	now?: () => number;
}): PendingAuth {
	const state = randomBytes(32).toString("base64url");
	const codeVerifier = randomBytes(48).toString("base64url");
	const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
	const authorizationUrl = new URL(discovery.authorizationEndpoint);
	authorizationUrl.searchParams.set("response_type", "code");
	authorizationUrl.searchParams.set("client_id", config.clientId);
	authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
	authorizationUrl.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
	authorizationUrl.searchParams.set("state", state);
	authorizationUrl.searchParams.set("code_challenge", challenge);
	authorizationUrl.searchParams.set("code_challenge_method", "S256");
	return {
		authType: "clerk_oauth_pkce",
		state,
		codeVerifier,
		authorizationUrl: authorizationUrl.toString(),
		redirectUri: config.redirectUri,
		issuer: config.issuer,
		clientId: config.clientId,
		audience: config.audience,
		authorizedParties: config.authorizedParties,
		tokenEndpoint: discovery.tokenEndpoint,
		expiresAt: new Date(now() + OAUTH_LOGIN_TTL_MS).toISOString(),
		apiUrl,
		scopes: [...REQUIRED_SCOPES],
	};
}

export function parseClerkOAuthCallback(pending: PendingAuth, raw: string): string {
	let callback: URL;
	try {
		callback = new URL(raw.trim());
	} catch {
		throw new ClerkOAuthError(
			"invalid_oauth_callback",
			"Paste the complete loopback callback URL from your browser.",
		);
	}
	const expected = new URL(pending.redirectUri);
	if (
		callback.origin !== expected.origin ||
		callback.pathname !== expected.pathname ||
		callback.username ||
		callback.password ||
		callback.hash ||
		callback.searchParams.get("state") !== pending.state
	) {
		throw new ClerkOAuthError(
			"invalid_oauth_callback",
			"OAuth callback validation failed. Start `clawdi auth login` again.",
		);
	}
	if (callback.searchParams.has("error")) {
		throw new ClerkOAuthError("oauth_denied", "Clawdi OAuth authorization was denied.");
	}
	const code = callback.searchParams.get("code")?.trim() ?? "";
	if (!code || code.length > 4_096) {
		throw new ClerkOAuthError(
			"invalid_oauth_callback",
			"OAuth callback did not contain a valid authorization code.",
		);
	}
	return code;
}

function validateOAuthAccessToken({
	token,
	issuer,
	clientId,
	audience,
	authorizedParties,
	now,
}: {
	token: string;
	issuer: string;
	clientId: string;
	audience: string;
	authorizedParties: readonly string[];
	now: number;
}): { expiresAt: string; userId: string } {
	const parts = oauthJwtParts(token);
	const headerType = parts?.header.typ;
	const headerAlgorithm = parts?.header.alg;
	const payload = parts?.payload;
	const tokenAudience = payload?.aud;
	const audienceMatches =
		!audience ||
		tokenAudience === undefined ||
		(typeof tokenAudience === "string" && tokenAudience.length > 0 && tokenAudience === audience) ||
		(Array.isArray(tokenAudience) &&
			tokenAudience.length > 0 &&
			tokenAudience.every((item) => typeof item === "string" && item.length > 0) &&
			tokenAudience.some((item) => item === audience));
	const authorizedParty = payload?.azp;
	const authorizedPartyMatches =
		authorizedParties.length === 0 ||
		(typeof authorizedParty === "string" &&
			authorizedParty.length > 0 &&
			authorizedParties.includes(authorizedParty));
	const issuedAt = payload?.iat;
	const notBefore = payload?.nbf;
	const expiresAtMs = typeof payload?.exp === "number" ? payload.exp * 1_000 : Number.NaN;
	const expiresAtDate = new Date(expiresAtMs);
	if (
		!parts ||
		typeof headerType !== "string" ||
		!OAUTH_ACCESS_TOKEN_TYPES.has(headerType) ||
		headerAlgorithm !== "RS256" ||
		payload?.iss !== issuer ||
		payload.client_id !== clientId ||
		!audienceMatches ||
		!authorizedPartyMatches ||
		typeof payload.sub !== "string" ||
		!payload.sub ||
		typeof payload.exp !== "number" ||
		!Number.isInteger(payload.exp) ||
		!Number.isFinite(expiresAtMs) ||
		Number.isNaN(expiresAtDate.getTime()) ||
		expiresAtMs <= now + 5_000 ||
		(issuedAt !== undefined &&
			(typeof issuedAt !== "number" ||
				!Number.isInteger(issuedAt) ||
				issuedAt * 1_000 > now + 5_000)) ||
		(notBefore !== undefined &&
			(typeof notBefore !== "number" ||
				!Number.isInteger(notBefore) ||
				notBefore * 1_000 > now + 5_000))
	) {
		throw new ClerkOAuthError(
			"invalid_oauth_token",
			"Clerk returned an access token for the wrong issuer, client, audience, or authorized party.",
		);
	}
	return { expiresAt: expiresAtDate.toISOString(), userId: payload.sub };
}

function tokenFormRequest(endpoint: string, body: URLSearchParams): Request {
	return new Request(endpoint, {
		method: "POST",
		redirect: "error",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});
}

async function tokenResponse(
	response: Response,
	context: {
		issuer: string;
		clientId: string;
		audience: string;
		authorizedParties: readonly string[];
		tokenEndpoint: string;
		now: number;
		priorRefreshToken?: string;
	},
): Promise<ClerkOAuthAuth> {
	if (!response.ok) {
		if (
			context.priorRefreshToken &&
			(response.status >= 500 ||
				response.status === 408 ||
				response.status === 425 ||
				response.status === 429)
		) {
			throw new ClerkOAuthError(
				"oauth_refresh_retryable",
				"Clawdi login could not be refreshed. Check your connection and retry.",
			);
		}
		throw new ClerkOAuthError(
			context.priorRefreshToken ? "oauth_session_expired" : "oauth_exchange_failed",
			context.priorRefreshToken
				? "Clawdi login could not be refreshed. Run `clawdi auth login` again."
				: "Clawdi login could not be completed. Run `clawdi auth login` again.",
		);
	}
	const body = await readJson(response);
	if (!isRecord(body)) {
		throw new ClerkOAuthError(
			"invalid_oauth_response",
			"Clerk returned an invalid token response.",
		);
	}
	const accessToken = nonEmptyString(body.access_token);
	const refreshToken = nonEmptyString(body.refresh_token) ?? context.priorRefreshToken ?? null;
	const tokenType = nonEmptyString(body.token_type, 64);
	const scope = nonEmptyString(body.scope, 4_096) ?? REQUIRED_SCOPES.join(" ");
	if (!accessToken || !refreshToken || tokenType?.toLowerCase() !== "bearer") {
		throw new ClerkOAuthError(
			"invalid_oauth_response",
			"Clerk returned an incomplete token response.",
		);
	}
	const validated = validateOAuthAccessToken({
		token: accessToken,
		issuer: context.issuer,
		clientId: context.clientId,
		audience: context.audience,
		authorizedParties: context.authorizedParties,
		now: context.now,
	});
	return {
		authType: "clerk_oauth",
		apiKey: accessToken,
		refreshToken,
		accessTokenExpiresAt: validated.expiresAt,
		issuer: context.issuer,
		clientId: context.clientId,
		audience: context.audience,
		authorizedParties: [...context.authorizedParties],
		tokenEndpoint: context.tokenEndpoint,
		scopes: scope.split(/\s+/).filter(Boolean),
		subject: validated.userId,
		userId: validated.userId,
	};
}

export async function exchangeClerkOAuthCode(
	pending: PendingAuth,
	callbackUrl: string,
	options: ClerkOAuthNetworkOptions = {},
): Promise<ClerkOAuthAuth> {
	const now = options.now ?? Date.now;
	if (pending.authType !== "clerk_oauth_pkce" || Date.parse(pending.expiresAt) <= now()) {
		throw new ClerkOAuthError(
			"oauth_login_expired",
			"Pending OAuth login expired. Run `clawdi auth login` again.",
		);
	}
	const code = parseClerkOAuthCallback(pending, callbackUrl);
	const form = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: pending.clientId,
		redirect_uri: pending.redirectUri,
		code,
		code_verifier: pending.codeVerifier,
	});
	const fetcher = options.fetch ?? fetchWithTimeout;
	const auth = await tokenResponse(await fetcher(tokenFormRequest(pending.tokenEndpoint, form)), {
		issuer: pending.issuer,
		clientId: pending.clientId,
		audience: pending.audience,
		authorizedParties: pending.authorizedParties ?? [],
		tokenEndpoint: pending.tokenEndpoint,
		now: now(),
	});
	return auth;
}

function credentialLockPath(): string {
	return join(getClawdiDir(), "credentials.lock");
}

function identityOf(auth: ReturnType<typeof getStoredAuth>): StoredCredentialIdentity {
	if (!auth) return { kind: "none" };
	if (isClerkOAuthAuth(auth)) return { kind: "clerk_oauth", subject: auth.subject };
	return {
		kind: "legacy_api_key",
		digest: createHash("sha256").update(auth.apiKey).digest("hex"),
	};
}

function sameCredentialIdentity(
	left: StoredCredentialIdentity,
	right: StoredCredentialIdentity,
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "none" && right.kind === "none") return true;
	if (left.kind === "clerk_oauth" && right.kind === "clerk_oauth") {
		return left.subject === right.subject;
	}
	return (
		left.kind === "legacy_api_key" &&
		right.kind === "legacy_api_key" &&
		left.digest === right.digest
	);
}

function pendingMatches(left: PendingAuth | null, right: PendingAuth): boolean {
	return left?.authType === "clerk_oauth_pkce" && left.state === right.state;
}

function assertPersistentCredentialWritesAllowed(): void {
	if (process.env.CLAWDI_AUTH_TOKEN) {
		throw new ClerkOAuthError(
			"environment_credential_active",
			"CLAWDI_AUTH_TOKEN controls this process; unset it before changing persisted login state.",
		);
	}
}

export function captureStoredCredentialIdentity(): StoredCredentialIdentity {
	return identityOf(getStoredAuth());
}

export async function persistPendingClerkOAuthLogin(
	pending: PendingAuth,
	expected: StoredCredentialIdentity,
	lockOptions?: PrivateDirectoryLockOptions,
): Promise<void> {
	assertPersistentCredentialWritesAllowed();
	await withPrivateDirectoryLock(
		credentialLockPath(),
		async (lease) => {
			if (!sameCredentialIdentity(identityOf(getStoredAuth()), expected)) {
				throw new ClerkOAuthError(
					"credential_state_changed",
					"Login state changed while OAuth authorization was starting. Retry without switching accounts concurrently.",
				);
			}
			lease.assertOwned();
			setPendingAuth(pending);
		},
		lockOptions,
	);
}

export async function clearPendingClerkOAuthLogin(
	pending: PendingAuth,
	lockOptions?: PrivateDirectoryLockOptions,
): Promise<void> {
	if (process.env.CLAWDI_AUTH_TOKEN) return;
	await withPrivateDirectoryLock(
		credentialLockPath(),
		async (lease) => {
			if (pendingMatches(getPendingAuth(), pending)) {
				lease.assertOwned();
				clearPendingAuth();
			}
		},
		lockOptions,
	);
}

export async function commitClawdiCredential(
	auth: ClawdiAuth,
	expected: StoredCredentialIdentity,
	options: { pending?: PendingAuth; lock?: PrivateDirectoryLockOptions } = {},
): Promise<void> {
	assertPersistentCredentialWritesAllowed();
	await withPrivateDirectoryLock(
		credentialLockPath(),
		async (lease) => {
			if (!sameCredentialIdentity(identityOf(getStoredAuth()), expected)) {
				throw new ClerkOAuthError(
					"credential_state_changed",
					"Login state changed while credentials were being verified. The newer identity was preserved.",
				);
			}
			if (options.pending && !pendingMatches(getPendingAuth(), options.pending)) {
				throw new ClerkOAuthError(
					"credential_state_changed",
					"OAuth transaction state changed before credentials could be saved. The newer state was preserved.",
				);
			}
			lease.assertOwned();
			setAuth(auth);
			if (options.pending) {
				lease.assertOwned();
				clearPendingAuth();
			}
		},
		options.lock,
	);
}

function cloudUser(value: unknown): ClerkOAuthCloudUser | null {
	if (!isRecord(value)) return null;
	const id = nonEmptyString(value.id, 512);
	if (!id) return null;
	const email = value.email === undefined ? undefined : nonEmptyString(value.email, 2_048);
	const name = value.name === undefined ? undefined : nonEmptyString(value.name, 2_048);
	if ((value.email !== undefined && !email) || (value.name !== undefined && !name)) return null;
	return { id, ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

function cloudVerificationMayBeRetried(status: number): boolean {
	return status >= 500 || status === 408 || status === 425 || status === 429;
}

async function revokeClerkOAuthGrant(
	apiUrl: string,
	auth: ClerkOAuthAuth,
	fetcher: FetchLike,
): Promise<void> {
	const endpoint = new URL("/v1/cli/auth/oauth/revoke", `${apiUrl.replace(/\/$/, "")}/`);
	const response = await fetcher(
		new Request(endpoint, {
			method: "POST",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${auth.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ refresh_token: auth.refreshToken }),
		}),
	);
	if (!response.ok) {
		throw new ClerkOAuthError(
			"oauth_revoke_failed",
			"Could not revoke the remote OAuth session. Local credentials will still be removed.",
		);
	}
}

async function rejectClerkOAuthGrant(
	apiUrl: string,
	auth: ClerkOAuthAuth,
	fetcher: FetchLike,
	code: string,
	message: string,
	pending: PendingAuth | undefined,
	lockOptions: PrivateDirectoryLockOptions | undefined,
): Promise<never> {
	try {
		await revokeClerkOAuthGrant(apiUrl, auth, fetcher);
	} catch {
		// Cloud already rejected the access token. Local cleanup is authoritative;
		// remote revocation remains best-effort and never exposes the refresh grant.
	}
	if (!process.env.CLAWDI_AUTH_TOKEN) {
		await withPrivateDirectoryLock(
			credentialLockPath(),
			async (lease) => {
				const current = getStoredAuth();
				if (
					isClerkOAuthAuth(current) &&
					current.subject === auth.subject &&
					current.refreshToken === auth.refreshToken
				) {
					lease.assertOwned();
					clearAuth();
				}
				if (pending && pendingMatches(getPendingAuth(), pending)) {
					lease.assertOwned();
					clearPendingAuth();
				}
			},
			lockOptions,
		);
	}
	throw new ClerkOAuthError(code, message);
}

async function persistVerifiedGrant(
	apiUrl: string,
	auth: ClerkOAuthAuth,
	expected: StoredCredentialIdentity,
	pending: PendingAuth | undefined,
	fetcher: FetchLike,
	lockOptions: PrivateDirectoryLockOptions | undefined,
): Promise<void> {
	try {
		await commitClawdiCredential(auth, expected, { pending, lock: lockOptions });
	} catch (error) {
		try {
			await revokeClerkOAuthGrant(apiUrl, auth, fetcher);
		} catch {
			// The uncommitted grant is best-effort revoked; never disturb the
			// credential identity that won the concurrent commit.
		}
		throw error;
	}
}

/**
 * Bind a newly exchanged Clerk grant to the Cloud account before reporting login.
 * Retryable Cloud failures retain the grant but return an explicit unverified state;
 * deterministic rejection revokes best-effort and always clears local auth.
 */
export async function verifyAndPersistClerkOAuthLogin(
	apiUrl: string,
	auth: ClerkOAuthAuth,
	options: ClerkOAuthNetworkOptions & {
		expectedCredential?: StoredCredentialIdentity;
		pending?: PendingAuth;
	} = {},
): Promise<ClerkOAuthCloudVerification> {
	const fetcher = options.fetch ?? fetchWithTimeout;
	const expected = options.expectedCredential ?? { kind: "none" };
	const endpoint = new URL("/v1/auth/me", `${apiUrl.replace(/\/$/, "")}/`);
	let response: Response;
	try {
		response = await fetcher(
			new Request(endpoint, {
				headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: "application/json" },
			}),
		);
	} catch {
		await persistVerifiedGrant(
			apiUrl,
			auth,
			expected,
			options.pending,
			fetcher,
			options.refreshLock,
		);
		return { kind: "cloud_unverified", reason: "network" };
	}

	if (!response.ok) {
		if (cloudVerificationMayBeRetried(response.status)) {
			await persistVerifiedGrant(
				apiUrl,
				auth,
				expected,
				options.pending,
				fetcher,
				options.refreshLock,
			);
			return {
				kind: "cloud_unverified",
				reason: "server_error",
				httpStatus: response.status,
			};
		}
		return rejectClerkOAuthGrant(
			apiUrl,
			auth,
			fetcher,
			"oauth_cloud_rejected",
			`Clawdi Cloud rejected the OAuth session (HTTP ${response.status}). Run \`clawdi auth login\` again.`,
			options.pending,
			options.refreshLock,
		);
	}

	let profile: ClerkOAuthCloudUser | null = null;
	try {
		profile = cloudUser(await response.json());
	} catch {
		profile = null;
	}
	if (!profile) {
		return rejectClerkOAuthGrant(
			apiUrl,
			auth,
			fetcher,
			"invalid_cloud_auth_response",
			"Clawdi Cloud returned an invalid account response. Run `clawdi auth login` again.",
			options.pending,
			options.refreshLock,
		);
	}

	await persistVerifiedGrant(
		apiUrl,
		{ ...auth, userId: profile.id, email: profile.email },
		expected,
		options.pending,
		fetcher,
		options.refreshLock,
	);
	return { kind: "verified", user: profile };
}

export function isClerkOAuthAuth(value: unknown): value is ClerkOAuthAuth {
	return (
		isRecord(value) &&
		value.authType === "clerk_oauth" &&
		typeof value.apiKey === "string" &&
		typeof value.refreshToken === "string" &&
		typeof value.accessTokenExpiresAt === "string" &&
		typeof value.issuer === "string" &&
		typeof value.clientId === "string" &&
		typeof value.audience === "string" &&
		(value.authorizedParties === undefined ||
			(Array.isArray(value.authorizedParties) &&
				value.authorizedParties.every((party) => typeof party === "string"))) &&
		typeof value.tokenEndpoint === "string" &&
		Array.isArray(value.scopes) &&
		value.scopes.every((scope) => typeof scope === "string") &&
		typeof value.subject === "string" &&
		typeof value.userId === "string"
	);
}

let refreshInFlight: Promise<string> | null = null;

async function refreshClerkOAuthGrant(
	auth: ClerkOAuthAuth,
	options: ClerkOAuthNetworkOptions,
): Promise<ClerkOAuthAuth> {
	const now = options.now ?? Date.now;
	const issuer = exactIssuer(auth.issuer);
	const tokenEndpoint = exactIssuerEndpoint(auth.tokenEndpoint, issuer, "token endpoint");
	const form = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: auth.clientId,
		refresh_token: auth.refreshToken,
	});
	const fetcher = options.fetch ?? fetchWithTimeout;
	const refreshed = await tokenResponse(await fetcher(tokenFormRequest(tokenEndpoint, form)), {
		issuer,
		clientId: auth.clientId,
		audience: auth.audience,
		authorizedParties: auth.authorizedParties ?? [],
		tokenEndpoint,
		now: now(),
		priorRefreshToken: auth.refreshToken,
	});
	if (refreshed.subject !== auth.subject) {
		throw new ClerkOAuthError(
			"oauth_subject_changed",
			"Clerk returned a refreshed session for a different user. Run `clawdi auth login` again.",
		);
	}
	refreshed.email = auth.email;
	refreshed.userId = auth.userId;
	return refreshed;
}

function sameRefreshCredential(current: ClerkOAuthAuth, failed: ClerkOAuthAuth): boolean {
	return (
		current.subject === failed.subject &&
		current.refreshToken === failed.refreshToken &&
		current.issuer === failed.issuer &&
		current.clientId === failed.clientId &&
		current.tokenEndpoint === failed.tokenEndpoint
	);
}

function terminalRefreshFailure(error: unknown): boolean {
	return (
		error instanceof ClerkOAuthError &&
		error.code !== "oauth_network_error" &&
		error.code !== "oauth_refresh_retryable"
	);
}

export async function getClawdiAccessToken(
	options: ClerkOAuthNetworkOptions = {},
): Promise<string> {
	const auth = getAuth();
	if (!auth?.apiKey) {
		throw new ClerkOAuthError(
			"oauth_login_required",
			"Not logged in. Run `clawdi auth login` first.",
		);
	}
	if (!isClerkOAuthAuth(auth)) return auth.apiKey;
	const now = options.now ?? Date.now;
	const expiresAt = Date.parse(auth.accessTokenExpiresAt);
	if (Number.isFinite(expiresAt) && expiresAt > now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
		return auth.apiKey;
	}
	if (!refreshInFlight) {
		refreshInFlight = withPrivateDirectoryLock(
			credentialLockPath(),
			async (lease) => {
				// Another CLI process may have refreshed while this process waited.
				// Re-read the atomic auth file inside the cross-process critical section.
				const latest = getStoredAuth();
				if (!latest?.apiKey) {
					throw new ClerkOAuthError(
						"oauth_login_required",
						"Not logged in. Run `clawdi auth login` first.",
					);
				}
				if (!isClerkOAuthAuth(latest)) return latest.apiKey;
				const latestExpiresAt = Date.parse(latest.accessTokenExpiresAt);
				if (
					Number.isFinite(latestExpiresAt) &&
					latestExpiresAt > now() + ACCESS_TOKEN_REFRESH_SKEW_MS
				) {
					return latest.apiKey;
				}

				let refreshed: ClerkOAuthAuth;
				try {
					refreshed = await refreshClerkOAuthGrant(latest, options);
				} catch (error) {
					if (terminalRefreshFailure(error)) {
						const current = getStoredAuth();
						if (isClerkOAuthAuth(current) && sameRefreshCredential(current, latest)) {
							lease.assertOwned();
							clearAuth();
						}
					}
					throw error;
				}
				lease.assertOwned();
				setAuth(refreshed);
				return refreshed.apiKey;
			},
			options.refreshLock,
		).finally(() => {
			refreshInFlight = null;
		});
	}
	return refreshInFlight;
}

export async function revokeClerkOAuthSession(
	apiUrl: string,
	options: ClerkOAuthNetworkOptions = {},
): Promise<void> {
	const fetcher = options.fetch ?? fetchWithTimeout;
	await withPrivateDirectoryLock(
		credentialLockPath(),
		async (lease) => {
			const current = getStoredAuth();
			if (!isClerkOAuthAuth(current)) return;
			await revokeClerkOAuthGrant(apiUrl, current, fetcher);
			lease.assertOwned();
		},
		options.refreshLock,
	);
}

export async function logoutClawdiCredentials(
	apiUrl: string,
	options: ClerkOAuthNetworkOptions = {},
): Promise<CredentialLogoutResult> {
	if (process.env.CLAWDI_AUTH_TOKEN) {
		return { loggedOut: false, remoteRevoked: false, environmentCredential: true };
	}
	const fetcher = options.fetch ?? fetchWithTimeout;
	return withPrivateDirectoryLock(
		credentialLockPath(),
		async (lease) => {
			const current = getStoredAuth();
			let remoteRevoked = false;
			if (isClerkOAuthAuth(current)) {
				try {
					const expiresAt = Date.parse(current.accessTokenExpiresAt);
					const now = options.now ?? Date.now;
					const latest =
						!Number.isFinite(expiresAt) || expiresAt <= now() + ACCESS_TOKEN_REFRESH_SKEW_MS
							? await refreshClerkOAuthGrant(current, options)
							: current;
					if (latest !== current) {
						lease.assertOwned();
						setAuth(latest);
					}
					await revokeClerkOAuthGrant(apiUrl, latest, fetcher);
					lease.assertOwned();
					remoteRevoked = true;
				} catch {
					remoteRevoked = false;
				}
			}
			lease.assertOwned();
			clearAuth();
			lease.assertOwned();
			clearPendingAuth();
			return {
				loggedOut: current !== null,
				remoteRevoked,
				environmentCredential: false,
			};
		},
		options.refreshLock,
	);
}
