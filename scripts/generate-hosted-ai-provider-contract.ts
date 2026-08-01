import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLAWDI_MANAGED_PROVIDER_ID } from "../packages/shared/src/ai-provider";
import {
	buildHostedAiBindingFields,
	type HostedSavedAiProvider,
} from "../packages/shared/src/api/hosted-ai-binding";

export const HOSTED_AI_PROVIDER_CONTRACT_FIXTURE_SCHEMA =
	"clawdi.hosted-ai-provider-contract-fixture.v1";

export const PUBLIC_HTTPS_URL_CASES = [
	{ url: "https://provider.example/v1", valid: true },
	{ url: "HTTPS://provider.example/v1", valid: true },
	{ url: "https://provider.example./v1", valid: true },
	{ url: "https://provider.example/v1;transport=responses", valid: true },
	{ url: "https://provider.example/v1%3Fquery%3Ddata", valid: true },
	{ url: "https://provider.example/v1%23fragment", valid: true },
	{ url: "https://provider.example/v1%3Bparam", valid: true },
	{ url: "https://8.8.8.8/v1", valid: true },
	{ url: "https://[2606:4700:4700::1111]/v1", valid: true },
	{ url: "http://provider.example/v1", valid: false },
	{ url: "https:///missing-host", valid: false },
	{ url: "https://user@provider.example/v1", valid: false },
	{ url: "https://user:password@provider.example/v1", valid: false },
	{ url: "https://provider.example/v1?mode=test", valid: false },
	{ url: "https://provider.example/v1?", valid: false },
	{ url: "https://provider.example/v1#fragment", valid: false },
	{ url: "https://provider.example/v1#", valid: false },
	{ url: "https://provider.example;port/v1", valid: false },
	{ url: "https://localhost/v1", valid: false },
	{ url: "https://api.localhost/v1", valid: false },
	{ url: "https://provider.local/v1", valid: false },
	{ url: "https://provider.internal/v1", valid: false },
	{ url: "https://provider.home.arpa/v1", valid: false },
	{ url: "https://provider.svc/v1", valid: false },
	{ url: "https://127.0.0.1/v1", valid: false },
	{ url: "https://10.0.0.1/v1", valid: false },
	{ url: "https://100.64.0.1/v1", valid: false },
	{ url: "https://169.254.169.254/v1", valid: false },
	{ url: "https://192.0.2.1/v1", valid: false },
	{ url: "https://224.0.0.1/v1", valid: false },
	{ url: "https://[::1]/v1", valid: false },
	{ url: "https://[2001:db8::1]/v1", valid: false },
	{ url: " https://provider.example/v1", valid: false },
	{ url: "https://provider.example/v1\n", valid: false },
	{ url: "https://provider.example:invalid/v1", valid: false },
] as const;

const apiKeyProvider = {
	id: "row-api-key",
	provider_id: "external-api-key",
	scope: "user",
	type: "openai",
	label: "External API key",
	base_url: "https://api.openai.com/v1",
	api_mode: "openai_responses",
	managed_by: "user",
	runtime_env_name: "OPENAI_API_KEY",
	capabilities: { chat: true, responses: true, tools: true },
	models: [{ id: "gpt-contract" }],
	auth: { type: "api_key", source: "managed", profile: "work" },
	usable: true,
	readiness: {
		credential_material: "available",
		runtime_compatibility: { openclaw: true, hermes: true, codex: true },
		deployable: true,
		endpoint_reachability: "not_tested",
		inference_verification: "not_tested",
	},
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
} satisfies HostedSavedAiProvider;

const oauthProvider = {
	...apiKeyProvider,
	id: "row-oauth",
	provider_id: "external-oauth",
	label: "External OAuth",
	runtime_env_name: null,
	models: [{ id: "gpt-codex-contract" }],
	auth: { type: "agent_profile", tool: "codex", profile: "default" },
} satisfies HostedSavedAiProvider;

const managedModels = [
	{
		id: "gpt-managed-contract",
		display_name: "Managed contract model",
		provider_id: "openai-codex",
		is_default: true,
		is_featured: true,
		description: null,
		capabilities: {
			context_window: 128_000,
			max_context_window: null,
			max_input_tokens: 128_000,
			max_output_tokens: null,
			input_modalities: ["text" as const],
			supports_vision: false,
			supports_reasoning: null,
			supports_tools: null,
		},
	},
];

function buildBindingFieldCases(): Array<Record<string, unknown>> {
	return [
		{
			case_id: "managed-primary-api-key-secondary",
			fields: buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [apiKeyProvider],
				selection: {
					mode: "managed",
					model: "gpt-managed-contract",
					providerIds: [CLAWDI_MANAGED_PROVIDER_ID, apiKeyProvider.provider_id],
				},
			}),
		},
		{
			case_id: "api-key-primary-managed-secondary",
			fields: buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [apiKeyProvider],
				selection: {
					mode: "saved",
					model: "gpt-contract",
					primaryProviderId: apiKeyProvider.provider_id,
					providerIds: [apiKeyProvider.provider_id, CLAWDI_MANAGED_PROVIDER_ID],
				},
			}),
		},
		{
			case_id: "oauth-primary-api-key-secondary",
			fields: buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [oauthProvider, apiKeyProvider],
				selection: {
					mode: "saved",
					model: "gpt-codex-contract",
					primaryProviderId: oauthProvider.provider_id,
					providerIds: [oauthProvider.provider_id, apiKeyProvider.provider_id],
				},
			}),
		},
		{
			case_id: "api-key-primary-oauth-secondary",
			fields: buildHostedAiBindingFields({
				managedModels,
				mode: "create",
				providers: [apiKeyProvider, oauthProvider],
				selection: {
					mode: "saved",
					model: "gpt-contract",
					primaryProviderId: apiKeyProvider.provider_id,
					providerIds: [apiKeyProvider.provider_id, oauthProvider.provider_id],
				},
			}),
		},
	];
}

export function hostedAiProviderContractPayload(): Record<string, unknown> {
	return {
		binding_field_cases: buildBindingFieldCases(),
		public_https_url_cases: PUBLIC_HTTPS_URL_CASES,
	};
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

export function renderHostedAiProviderContractFixture(coreCommit: string): string {
	if (!/^[0-9a-f]{40}$/.test(coreCommit)) {
		throw new Error("Core provenance commit must be a full lowercase Git object id.");
	}
	const payload = hostedAiProviderContractPayload();
	const payloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
	return `${canonicalJson({
		fixture_schema: HOSTED_AI_PROVIDER_CONTRACT_FIXTURE_SCHEMA,
		generated_from: {
			binding_builder: "buildHostedAiBindingFields",
			binding_wire_schema: "HostedAiProviderBootstrap.schema_version=1",
			core_commit: coreCommit,
			generator: "scripts/generate-hosted-ai-provider-contract.ts",
		},
		payload,
		payload_sha256: payloadSha256,
	})}\n`;
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, nested]) => [key, canonicalValue(nested)]),
		);
	}
	return value;
}

if (import.meta.main) {
	const coreCommit = process.argv[2];
	if (!coreCommit) {
		throw new Error(
			"Usage: bun run scripts/generate-hosted-ai-provider-contract.ts <core-commit> [output]",
		);
	}
	const commitCheck = spawnSync("git", ["cat-file", "-e", `${coreCommit}^{commit}`], {
		stdio: "ignore",
	});
	if (commitCheck.status !== 0) {
		throw new Error(`Core provenance commit does not exist: ${coreCommit}`);
	}
	const outputPath = resolve(process.argv[3] ?? "test-fixtures/hosted-ai-provider-contract.json");
	writeFileSync(outputPath, renderHostedAiProviderContractFixture(coreCommit), { mode: 0o644 });
}
