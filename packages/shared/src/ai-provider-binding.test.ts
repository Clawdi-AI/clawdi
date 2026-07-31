import { describe, expect, test } from "bun:test";
import { normalizeAiProviderBindingPool } from "./ai-provider-binding";

const primaryModel = { provider_id: "managed", model: "gpt-test" };

describe("canonical AI provider binding pool", () => {
	test("preserves order and structured external secret references", () => {
		expect(
			normalizeAiProviderBindingPool({
				bindings: [
					{ provider_id: "managed", auth_kind: "managed" },
					{
						provider_id: "external-api",
						auth_kind: "api_key",
						secret_reference: { store: "external", name: "external-api" },
					},
				],
				primaryModel,
			}),
		).toEqual([
			{ provider_id: "managed", auth_kind: "managed" },
			{
				provider_id: "external-api",
				auth_kind: "api_key",
				secret_reference: { store: "external", name: "external-api" },
			},
		]);
	});

	test.each([
		["external auth without ref", [{ provider_id: "external", auth_kind: "api_key" }]],
		[
			"mismatched external ref",
			[
				{
					provider_id: "external",
					auth_kind: "api_key",
					secret_reference: { store: "external", name: "other" },
				},
			],
		],
		[
			"managed ref",
			[
				{
					provider_id: "managed",
					auth_kind: "managed",
					secret_reference: { store: "external", name: "managed" },
				},
			],
		],
	] as const)("rejects %s", (_name, bindings) => {
		expect(() => normalizeAiProviderBindingPool({ bindings, primaryModel })).toThrow();
	});

	test("rejects duplicates, a primary outside the pool, and multiple OAuth families", () => {
		const external = (providerId: string) => ({
			provider_id: providerId,
			auth_kind: "codex_oauth" as const,
			secret_reference: { store: "external" as const, name: providerId },
		});
		expect(() =>
			normalizeAiProviderBindingPool({
				bindings: [external("oauth"), external("oauth")],
				primaryModel: { provider_id: "oauth", model: "gpt-test" },
			}),
		).toThrow("duplicate");
		expect(() =>
			normalizeAiProviderBindingPool({
				bindings: [external("oauth")],
				primaryModel,
			}),
		).toThrow("must belong");
		expect(() =>
			normalizeAiProviderBindingPool({
				bindings: [external("oauth-a"), external("oauth-b")],
				primaryModel: { provider_id: "oauth-a", model: "gpt-test" },
			}),
		).toThrow("more than one OAuth");
	});

	test.each(["", "   "])("rejects blank provider ids (%j)", (providerId) => {
		expect(() =>
			normalizeAiProviderBindingPool({
				bindings: [{ provider_id: providerId, auth_kind: "managed" }],
				primaryModel: { provider_id: providerId, model: "gpt-test" },
			}),
		).toThrow("invalid provider_id");
	});

	test("enforces Hosted pool and secret-version wire bounds", () => {
		const external = (providerId: string, version?: string) => ({
			provider_id: providerId,
			auth_kind: "api_key" as const,
			secret_reference: {
				store: "external" as const,
				name: providerId,
				...(version ? { version } : {}),
			},
		});
		const twenty = Array.from({ length: 20 }, (_, index) => external(`provider-${index}`));
		expect(
			normalizeAiProviderBindingPool({
				bindings: twenty,
				primaryModel: { provider_id: "provider-0", model: "gpt-test" },
			}),
		).toHaveLength(20);
		expect(() =>
			normalizeAiProviderBindingPool({
				bindings: [...twenty, external("provider-20")],
				primaryModel: { provider_id: "provider-0", model: "gpt-test" },
			}),
		).toThrow("more than 20");
		expect(
			normalizeAiProviderBindingPool({
				bindings: [external("external", "v".repeat(128))],
				primaryModel: { provider_id: "external", model: "gpt-test" },
			})[0]?.secret_reference?.version,
		).toHaveLength(128);
		expect(() =>
			normalizeAiProviderBindingPool({
				bindings: [external("external", "v".repeat(129))],
				primaryModel: { provider_id: "external", model: "gpt-test" },
			}),
		).toThrow("exceeds 128");
	});
});
