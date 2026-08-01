import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../../..");
const fixturePath = resolve(repositoryRoot, "test-fixtures/hosted-ai-provider-contract.json");
const generatorPath = resolve(repositoryRoot, "scripts/generate-hosted-ai-provider-contract.ts");

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, nested]) => [key, canonicalValue(nested)]),
		);
	}
	return value;
}

describe("Hosted AI provider cross-repository contract", () => {
	test("is generated exactly from the canonical Core binding builder", () => {
		const bytes = readFileSync(fixturePath, "utf8");
		const fixture = record(JSON.parse(bytes), "fixture");
		const generatedFrom = record(fixture.generated_from, "generated_from");
		const coreCommit = generatedFrom.core_commit;
		expect(coreCommit).toMatch(/^[0-9a-f]{40}$/);
		if (typeof coreCommit !== "string") throw new Error("core_commit must be a string");

		const tempRoot = mkdtempSync(join(tmpdir(), "clawdi-hosted-provider-contract-"));
		try {
			const generatedPath = join(tempRoot, "fixture.json");
			const generation = spawnSync("bun", ["run", generatorPath, coreCommit, generatedPath], {
				cwd: repositoryRoot,
				encoding: "utf8",
			});
			expect(generation.status).toBe(0);
			expect(generation.stderr).toBe("");
			expect(readFileSync(generatedPath, "utf8")).toBe(bytes);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("has a verifiable non-self-referential payload hash and stable bootstrap wire", () => {
		const fixture = record(JSON.parse(readFileSync(fixturePath, "utf8")), "fixture");
		const payload = record(fixture.payload, "payload");
		const payloadHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
		expect(fixture.payload_sha256).toBe(payloadHash);

		const bindingCases = payload.binding_field_cases;
		if (!Array.isArray(bindingCases)) throw new Error("binding_field_cases must be an array");
		const summaries = bindingCases.map((value) => {
			const bindingCase = record(value, "binding case");
			const fields = record(bindingCase.fields, "fields");
			const bootstrap = record(fields.ai_provider_bootstrap, "ai_provider_bootstrap");
			expect(Object.keys(bootstrap).sort()).toEqual([
				"auth_kind",
				"catalog",
				"schema_version",
				"selected_provider_id",
			]);
			expect(bootstrap).not.toHaveProperty("bindings");
			const catalog = record(bootstrap.catalog, "catalog");
			if (!Array.isArray(catalog.providers)) throw new Error("catalog.providers must be an array");
			return {
				caseId: bindingCase.case_id,
				authKind: fields.ai_provider_auth_kind,
				providerIds: fields.provider_ids,
				catalogAuth: catalog.providers.map(
					(provider) => record(record(provider, "provider").auth, "provider auth").type,
				),
			};
		});

		expect(summaries).toEqual([
			{
				caseId: "managed-primary-api-key-secondary",
				authKind: "managed",
				providerIds: ["clawdi", "external-api-key"],
				catalogAuth: ["api_key"],
			},
			{
				caseId: "api-key-primary-managed-secondary",
				authKind: "api_key",
				providerIds: ["external-api-key", "clawdi"],
				catalogAuth: ["api_key"],
			},
			{
				caseId: "oauth-primary-api-key-secondary",
				authKind: "codex_oauth",
				providerIds: ["external-oauth", "external-api-key"],
				catalogAuth: ["agent_profile", "api_key"],
			},
			{
				caseId: "api-key-primary-oauth-secondary",
				authKind: "api_key",
				providerIds: ["external-api-key", "external-oauth"],
				catalogAuth: ["api_key", "agent_profile"],
			},
		]);
	});
});
