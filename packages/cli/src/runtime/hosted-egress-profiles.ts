import { createHash } from "node:crypto";
import { CLAWDI_MANAGED_PROVIDER_ID, isClawdiManagedV2ProviderId } from "@clawdi/shared";
import { MANAGED_EGRESS_PLACEHOLDER_VALUE } from "./egress-env";
import { type EgressProfileInputBundle, egressProfileInputBundleSchema } from "./egress-profiles";
import { hostedMcpDesiredStateSchema } from "./manifest-resources";

type HostedEgressProfile = EgressProfileInputBundle["profiles"][number];

interface HostedRuntimeManifestProjection {
	egressProfiles?: unknown;
	providers?: unknown;
	terminalTooling?: unknown;
	mcp?: unknown;
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
		...managedProviderEgressProfiles(hosted),
		...managedMcpEgressProfiles(hosted),
	]);
}

export function managedMcpEgressProfiles(
	hosted: HostedRuntimeManifestProjection,
): HostedEgressProfile[] {
	if (
		typeof hosted.mcp !== "object" ||
		hosted.mcp === null ||
		Array.isArray(hosted.mcp) ||
		!Object.hasOwn(hosted.mcp, "servers")
	) {
		return [];
	}
	const parsed = hostedMcpDesiredStateSchema.parse(hosted.mcp);
	const profiles: HostedEgressProfile[] = [];
	for (const [name, server] of Object.entries(parsed.servers)) {
		if (!("url" in server)) continue;
		const secretHeaders = Object.entries(server.headers).filter(
			(entry): entry is [string, { secretRef: string; prefix: string }] =>
				typeof entry[1] !== "string",
		);
		if (secretHeaders.length === 0) continue;
		const url = new URL(server.url);
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		profiles.push({
			id: `managed-mcp-${profileIdSuffix(name)}`,
			enabled: true,
			kind: "provider",
			match: {
				scheme: url.protocol.slice(0, -1) as "http" | "https",
				host: `${url.hostname.toLowerCase()}:${port}`,
				path: { type: "equals", value: url.pathname || "/" },
				headers: Object.fromEntries(
					secretHeaders.map(([header, value]) => [
						header,
						{
							type: "equals" as const,
							value: managedMcpHeaderPlaceholder(name, header),
							prefix: value.prefix,
						},
					]),
				),
				query: {},
			},
			rewrite: {
				preservePath: true,
				setHeaders: Object.fromEntries(
					secretHeaders.map(([header, value]) => [
						header,
						{ type: "secretRef" as const, secretRef: value.secretRef, prefix: value.prefix },
					]),
				),
			},
			logging: {
				redactHeaders: secretHeaders.map(([header]) => header),
				redactUrlPatterns: [],
			},
			priority: 70,
			owner: "mcp-projection",
			description: `Managed remote MCP credentials for ${name}.`,
		});
	}
	return profiles;
}

export function managedMcpHeaderPlaceholder(serverName: string, headerName: string): string {
	const suffix = createHash("sha256")
		.update(`${serverName}\0${headerName.toLowerCase()}`)
		.digest("hex")
		.slice(0, 16);
	return `${MANAGED_EGRESS_PLACEHOLDER_VALUE}-mcp-${suffix}`;
}

function providerUsesManagedEgressProfile(apiMode: string | null): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}

export function managedProviderEgressProfiles(
	hosted: HostedRuntimeManifestProjection,
): HostedEgressProfile[] {
	const profiles: HostedEgressProfile[] = [];
	const seenMatches = new Set<string>();
	for (const [providerId, provider] of managedProviderProjectionEntries(hosted)) {
		const profile = managedProviderEgressProfileForProvider(providerId, provider);
		if (!profile) continue;
		const secretRef = normalizeSecretRef(provider.apiKeySecretRef);
		const matchKey = [
			profile.match.scheme,
			profile.match.host,
			profile.match.pathPrefix ?? "",
			secretRef ?? "",
		].join(":");
		if (seenMatches.has(matchKey)) continue;
		seenMatches.add(matchKey);
		profiles.push(profile);
	}
	return profiles;
}

function managedProviderProjectionEntries(
	hosted: HostedRuntimeManifestProjection,
): Array<[string, HostedProviderProjection]> {
	const entries = providerProjectionEntries(hosted.providers);
	const terminalTooling = recordValue(hosted.terminalTooling);
	const codex = recordValue(terminalTooling?.codex);
	const provider = providerProjectionValue(codex?.provider);
	const providerId = cleanString(typeof codex?.provider_id === "string" ? codex.provider_id : null);
	if (providerId && provider) entries.push([providerId, provider]);
	return entries;
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
	const profileProviderId = isClawdiManagedV2ProviderId(providerId)
		? CLAWDI_MANAGED_PROVIDER_ID
		: providerId;
	return {
		id:
			profileProviderId === "default"
				? "managed-provider"
				: `managed-provider-${profileIdSuffix(profileProviderId)}`,
		enabled: true,
		kind: "provider",
		match: {
			scheme: parsed.protocol.replace(/:$/, "") as "http" | "https" | "ws" | "wss",
			host: parsed.host.toLowerCase(),
			pathPrefix: managedProviderPathPrefix(parsed.pathname),
			headers: {
				authorization: {
					type: "equals",
					value: MANAGED_EGRESS_PLACEHOLDER_VALUE,
					prefix: "Bearer ",
				},
			},
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

function managedProviderPathPrefix(pathname: string): string {
	if (pathname === "/") return pathname;
	return `${pathname.replace(/\/+$/, "")}/`;
}

export function normalizeSecretRef(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed?.startsWith("secret://") && trimmed.length > "secret://".length ? trimmed : null;
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

function providerProjectionValue(value: unknown): HostedProviderProjection | null {
	const provider = recordValue(value);
	if (!provider) return null;
	return {
		baseUrl: nullableString(provider.baseUrl),
		apiMode: nullableString(provider.apiMode),
		apiKeySecretRef: nullableString(provider.apiKeySecretRef),
		managed_by: nullableString(provider.managed_by),
		status: nullableString(provider.status),
	};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function cleanString(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed || null;
}

function nullableString(value: unknown): string | null | undefined {
	return value === null || typeof value === "string" ? value : undefined;
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
