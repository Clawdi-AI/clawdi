import { describe, expect, test } from "bun:test";
import type { HostedRuntimeConfiguration } from "@/hosted/billing/contracts";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import {
	keepAgentOwnSettingsUpdate,
	providerConflictDisplayId,
	providerConflictNotices,
} from "@/hosted/v2/ai-providers/provider-conflicts";

type BoundProvider = HostedRuntimeConfiguration["providers"][number];

function boundProvider(providerId: string, authKind: BoundProvider["auth_kind"]): BoundProvider {
	return { provider_id: providerId, auth_kind: authKind, models: [] };
}

function configuration(...providers: BoundProvider[]): HostedRuntimeConfiguration {
	return { providers, features: [] };
}

describe("providerConflictNotices", () => {
	test("treats a missing or empty field from an older backend as no conflicts", () => {
		expect(providerConflictNotices(hostedDeploymentFixture())).toEqual([]);
		expect(providerConflictNotices(hostedDeploymentFixture({ providerConflicts: [] }))).toEqual([]);
	});

	test("offers removal for this agent's sole conflicting provider binding", () => {
		const deployment = hostedDeploymentFixture({
			runtime: "hermes",
			runtimeConfiguration: configuration(boundProvider("custom-openrouter", "secret_reference")),
			providerConflicts: [
				{ runtime: "hermes", provider_id: "custom-openrouter", code: "native_provider_exists" },
				// Another runtime never affects this agent.
				{
					runtime: "openclaw",
					provider_id: "custom-openrouter",
					code: "native_credential_pool_conflict",
				},
			],
		});

		expect(providerConflictNotices(deployment)).toEqual([
			{
				providerId: "custom-openrouter",
				runtime: "hermes",
				code: "native_provider_exists",
				removable: true,
			},
		]);
	});

	test("keeps the pool-conflict code so the notice can name the stored key", () => {
		const deployment = hostedDeploymentFixture({
			runtime: "openclaw",
			runtimeConfiguration: configuration(boundProvider("anthropic", "secret_reference")),
			providerConflicts: [
				{
					runtime: "openclaw",
					provider_id: "anthropic",
					code: "native_credential_pool_conflict",
				},
			],
		});
		expect(providerConflictNotices(deployment)[0]?.code).toBe("native_credential_pool_conflict");
	});

	test("matches Clawdi AI's per-agent managed id to its public binding id", () => {
		const deployment = hostedDeploymentFixture({
			runtime: "hermes",
			runtimeConfiguration: configuration(boundProvider("clawdi", "managed")),
			providerConflicts: [
				{
					runtime: "hermes",
					provider_id: "clawdi-v2-deployment-42",
					code: "native_provider_exists",
				},
			],
		});
		const [notice] = providerConflictNotices(deployment);
		expect(notice?.removable).toBe(true);
		if (!notice) throw new Error("Expected a notice");
		expect(providerConflictDisplayId(notice, deployment)).toBe("clawdi");
	});

	test("does not offer single-provider removal for unbound or multi-provider agents", () => {
		const unbound = hostedDeploymentFixture({
			runtime: "hermes",
			runtimeConfiguration: configuration(boundProvider("openai", "secret_reference")),
			providerConflicts: [
				{ runtime: "hermes", provider_id: "anthropic", code: "native_provider_exists" },
			],
		});
		expect(providerConflictNotices(unbound)[0]?.removable).toBe(false);

		const historical = hostedDeploymentFixture({
			runtime: "hermes",
			runtimeConfiguration: configuration(
				boundProvider("anthropic", "secret_reference"),
				boundProvider("openai", "secret_reference"),
			),
			providerConflicts: [
				{ runtime: "hermes", provider_id: "anthropic", code: "native_provider_exists" },
			],
		});
		expect(providerConflictNotices(historical)[0]?.removable).toBe(false);
	});
});

test("keeping the agent's own settings removes the Clawdi provider binding via the update flow", () => {
	expect(keepAgentOwnSettingsUpdate()).toEqual({
		ai_provider_auth_kind: "unmanaged",
		ai_provider_id: null,
		provider_ids: [],
		primary_model: null,
		ai_provider_bootstrap: null,
	});
});
