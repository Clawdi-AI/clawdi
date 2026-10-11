/** External boundaries only: the CLI entrypoint, commands and JSON emitters stay real. */
import { mock, spyOn } from "bun:test";
import { adapterRegistry } from "../../src/adapters/registry";
import { setAuth, setConfigKey } from "../../src/lib/config";
import * as installer from "../../src/serve/installer";
import { jsonResponse, mockFetch } from "../commands/helpers";

const scenario = process.env.CLAWDI_CONTRACT_SCENARIO;
const apiUrl = "https://api.contract.test";
const issuer = "https://clerk.contract.test";
const accountId = "contract-user";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = `${encode({ alg: "RS256", typ: "at+jwt" })}.${encode({ iss: issuer, client_id: "contract-cli", sub: accountId, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;

if (scenario !== "signed-out" && !scenario?.startsWith("login-")) {
	setAuth({
		authType: "clerk_oauth",
		apiKey: accessToken,
		refreshToken: "fixture-refresh",
		accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
		issuer,
		clientId: "contract-cli",
		tokenEndpoint: `${issuer}/oauth/token`,
		scopes: ["openid", "profile", "email", "offline_access"],
		userId: accountId,
		email: "contract@example.test",
		endpointBinding: {
			version: 1,
			cloudApiOrigin: apiUrl,
			hostedApiOrigin: "https://deploy.contract.test",
		},
	});
}
setConfigKey("excludeProjects", "/contract/project");
for (const [type, entry] of Object.entries(adapterRegistry)) {
	const adapter = entry.create();
	const detect = spyOn(adapter, "detect");
	if (scenario === "inspection-failed" && type === "codex")
		detect.mockRejectedValue(new Error("fixture inspection failed"));
	else detect.mockResolvedValue(true);
	spyOn(adapter, "getVersion").mockResolvedValue("1.2.3");
	spyOn(entry, "create").mockReturnValue(adapter);
}
spyOn(installer, "isSingletonDaemonInstalled").mockReturnValue(false);
spyOn(installer, "isSingletonDaemonRunning").mockReturnValue(false);
mock.module("../../src/lib/browser", () => ({ openInBrowser() {} }));

mockFetch([
	{
		method: "GET",
		path: "/v1/cli/auth/oauth/config",
		response: () => jsonResponse({ issuer, client_id: "contract-cli" }),
	},
	{
		method: "GET",
		path: "/.well-known/oauth-authorization-server",
		response: () =>
			jsonResponse({
				issuer,
				device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
				token_endpoint: `${issuer}/oauth/token`,
				grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
			}),
	},
	{
		method: "POST",
		path: "/oauth/device_authorization",
		response: () =>
			jsonResponse({
				device_code: "fixture-device-code",
				user_code: "ABCD-EFGH",
				verification_uri: "https://accounts.contract.test/device",
				expires_in: 600,
				interval: 1,
			}),
	},
	{
		method: "POST",
		path: "/oauth/token",
		response: () =>
			scenario === "login-cancelled"
				? jsonResponse({ error: "access_denied" }, 400)
				: scenario === "login-failed"
					? jsonResponse({ error: "invalid_grant" }, 400)
					: jsonResponse({
							access_token: accessToken,
							refresh_token: "fixture-refresh",
							token_type: "Bearer",
							expires_in: 3600,
							scope: "openid profile email offline_access",
						}),
	},
	{
		method: "GET",
		path: "/v1/auth/me",
		response: () =>
			jsonResponse({ id: accountId, email: "contract@example.test", name: "Contract User" }),
	},
	{
		method: "POST",
		path: "/v1/cli/auth/oauth/desktop-ticket",
		response: () =>
			scenario === "session-failed"
				? jsonResponse({ detail: "fixture unavailable" }, 400)
				: jsonResponse({
						status:
							scenario === "session-signed-in"
								? "signed-in"
								: scenario === "session-sign-out"
									? "sign-out"
									: "ticket",
						...(scenario === "session-signed-in" || scenario === "session-sign-out"
							? { ticket: null, expires_in: 0 }
							: { ticket: "fixture-ticket", expires_in: 60 }),
						clerk_user_id: accountId,
					}),
	},
	{
		method: "POST",
		path: "/v1/cli/auth/oauth/desktop-session/revoke",
		response: () => jsonResponse({ status: "revoked" }),
	},
	{
		method: "GET",
		path: "/v1/agents",
		response: () =>
			jsonResponse([
				{
					id: "00000000-0000-0000-0000-000000000001",
					agent_type: "codex",
					name: "Workstation",
					machine_name: "Contract Computer",
					machine_id: "other-machine",
					last_sync_at: null,
				},
			]),
	},
]);
