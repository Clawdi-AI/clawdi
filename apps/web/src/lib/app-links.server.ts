import { webLinkPaths } from "../../../mobile/config/linking.cjs";

const appId = "ai.clawdi.app";

/** Owner-supplied public signing identities, read only on the server. */
function readAppLinkConfig() {
	const teamId = process.env.CLAWDI_APPLE_TEAM_ID?.trim();
	const fingerprints = process.env.CLAWDI_ANDROID_CERT_SHA256?.split(",").map((value) =>
		value.trim().toUpperCase(),
	);
	return {
		appleTeamId: teamId && /^[A-Z0-9]{10}$/.test(teamId) ? teamId : null,
		androidCertSha256:
			fingerprints?.length &&
			fingerprints.every((value) => /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))
				? [...new Set(fingerprints)]
				: null,
	};
}

function associationResponse(body: unknown): Response {
	return new Response(body === null ? null : JSON.stringify(body), {
		status: body === null ? 404 : 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": body === null ? "no-store" : "public, max-age=300",
		},
	});
}

export function appleAppSiteAssociation(): Response {
	const { appleTeamId } = readAppLinkConfig();
	if (!appleTeamId) return associationResponse(null);
	const applicationId = `${appleTeamId}.${appId}`;
	return associationResponse({
		applinks: {
			details: [
				{
					appIDs: [applicationId],
					components: webLinkPaths.map((path) => ({ "/": path.path ?? `${path.pathPrefix}*` })),
				},
			],
		},
		webcredentials: { apps: [applicationId] },
	});
}

export function androidAssetLinks(): Response {
	const { androidCertSha256 } = readAppLinkConfig();
	if (!androidCertSha256) return associationResponse(null);
	return associationResponse([
		{
			relation: ["delegate_permission/common.handle_all_urls"],
			target: {
				namespace: "android_app",
				package_name: appId,
				sha256_cert_fingerprints: androidCertSha256,
			},
		},
	]);
}
