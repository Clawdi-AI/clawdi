import { type EgressProfileInputBundle, egressProfileInputBundleSchema } from "./egress-profiles";

type HostedEgressProfile = EgressProfileInputBundle["profiles"][number];

interface HostedRuntimeManifestProjection {
	egressProfiles?: unknown;
	providers?: unknown;
}

interface HostedProviderProjection {
	baseUrl?: string | null;
	apiMode?: string | null;
	apiKeySecretRef?: string | null;
	managed_by?: string | null;
	status?: string | null;
}

export function hostedManifestEgressProfiles(
	hosted: HostedRuntimeManifestProjection,
): EgressProfileInputBundle {
	const explicit =
		hosted.egressProfiles !== undefined
			? egressProfileInputBundleSchema.parse(hosted.egressProfiles)
			: { profiles: [] };
	return mergeGeneratedProfiles(explicit, [
		...runtimeInstallerEgressProfiles(),
		...managedProviderEgressProfiles(hosted),
	]);
}

export function runtimeInstallerEgressProfiles(): HostedEgressProfile[] {
	const profile = (
		id: string,
		host: string,
		pathPrefix: string,
		description: string,
	): HostedEgressProfile => ({
		id,
		enabled: true,
		kind: "passthrough",
		match: {
			scheme: "https",
			host,
			pathPrefix,
			headers: {},
			query: {},
		},
		logging: { redactHeaders: [], redactUrlPatterns: [] },
		priority: 200,
		owner: "runtime-installer",
		description,
	});
	return [
		profile(
			"runtime-installer-openclaw-install",
			"openclaw.ai",
			"/install-cli.sh",
			"OpenClaw official installer script.",
		),
		profile(
			"runtime-installer-nodejs-dist",
			"nodejs.org",
			"/dist/",
			"Node.js release artifacts used by the OpenClaw official installer.",
		),
		profile(
			"runtime-installer-npm-registry",
			"registry.npmjs.org",
			"/",
			"npm package metadata and tarballs used by the OpenClaw official installer.",
		),
		profile(
			"runtime-installer-hermes-install",
			"hermes-agent.nousresearch.com",
			"/install.sh",
			"Hermes official installer script.",
		),
		profile("runtime-installer-uv", "astral.sh", "/uv/", "uv installer bootstrap."),
		profile(
			"runtime-installer-uv-releases",
			"releases.astral.sh",
			"/installers/uv/",
			"uv installer release script.",
		),
		profile("runtime-installer-github", "github.com", "/", "Installer release metadata."),
		profile(
			"runtime-installer-github-api",
			"api.github.com",
			"/",
			"Installer release metadata API.",
		),
		profile(
			"runtime-installer-github-raw",
			"raw.githubusercontent.com",
			"/",
			"Installer release script assets.",
		),
		profile(
			"runtime-installer-github-objects",
			"objects.githubusercontent.com",
			"/",
			"Installer release binary assets.",
		),
		profile(
			"runtime-installer-github-release-assets",
			"release-assets.githubusercontent.com",
			"/",
			"Installer release binary assets.",
		),
		profile("runtime-installer-pypi", "pypi.org", "/simple/", "Hermes Python package index."),
		profile(
			"runtime-installer-pythonhosted",
			"files.pythonhosted.org",
			"/",
			"Hermes Python package artifacts.",
		),
	];
}

function providerUsesManagedEgressProfile(apiMode: string | null): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}

export function managedProviderEgressProfiles(
	hosted: HostedRuntimeManifestProjection,
): HostedEgressProfile[] {
	const profiles: HostedEgressProfile[] = [];
	const seenMatches = new Set<string>();
	for (const [providerId, provider] of providerProjectionEntries(hosted.providers)) {
		const profile = managedProviderEgressProfileForProvider(providerId, provider);
		if (!profile) continue;
		const matchKey = `${profile.match.scheme}:${profile.match.host}`;
		if (seenMatches.has(matchKey)) continue;
		seenMatches.add(matchKey);
		profiles.push(profile);
	}
	return profiles;
}

function managedProviderEgressProfileForProvider(
	providerId: string,
	provider: HostedProviderProjection,
): HostedEgressProfile | null {
	const providerBaseUrl = cleanBaseUrl(provider?.baseUrl);
	const providerApiMode = cleanString(provider?.apiMode);
	const secretRef = normalizeSecretRef(provider?.apiKeySecretRef);
	if (
		!isClawdiManagedProviderProjection(provider) ||
		!providerBaseUrl ||
		!secretRef ||
		!providerUsesManagedEgressProfile(providerApiMode)
	) {
		return null;
	}
	if (cleanString(provider.status) && cleanString(provider.status) !== "ok") return null;
	const parsed = new URL(providerBaseUrl);
	return {
		id:
			providerId === "default"
				? "managed-provider"
				: `managed-provider-${profileIdSuffix(providerId)}`,
		enabled: true,
		kind: "provider",
		match: {
			scheme: parsed.protocol.replace(/:$/, "") as "http" | "https" | "ws" | "wss",
			host: parsed.host.toLowerCase(),
			headers: {},
			query: {},
		},
		rewrite: {
			preservePath: true,
			setHeaders: {
				authorization: {
					type: "secretRef",
					secretRef,
					prefix: "Bearer ",
				},
			},
		},
		logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
		priority: 80,
		owner: "provider-projection",
	};
}

export function normalizeSecretRef(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return trimmed.startsWith("secret://") ? trimmed : `secret://${trimmed}`;
}

export function isClawdiManagedProviderProjection(provider: { managed_by?: unknown }): boolean {
	return provider.managed_by === "clawdi";
}

function providerProjectionEntries(value: unknown): Array<[string, HostedProviderProjection]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.entries(value)
		.filter((entry): entry is [string, HostedProviderProjection] => {
			const [providerId, provider] = entry;
			return (
				providerId.trim().length > 0 &&
				typeof provider === "object" &&
				provider !== null &&
				!Array.isArray(provider)
			);
		})
		.sort(([left], [right]) => {
			if (left === "default") return -1;
			if (right === "default") return 1;
			return left.localeCompare(right);
		});
}

function cleanString(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed || null;
}

function cleanBaseUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return null;
		return parsed.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function mergeGeneratedProfiles(
	explicit: EgressProfileInputBundle,
	generated: HostedEgressProfile[],
): EgressProfileInputBundle {
	const generatedIds = new Set(generated.map((profile) => profile.id));
	return {
		profiles: [
			...explicit.profiles.filter((profile) => !generatedIds.has(profile.id)),
			...generated,
		],
	};
}

function profileIdSuffix(value: string): string {
	const suffix = value
		.toLowerCase()
		.replace(/[^a-z0-9-_.]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.replace(/[^a-z0-9]+$/, "");
	return suffix || "provider";
}
