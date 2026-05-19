import { describe, expect, it } from "bun:test";

import {
	buildExactClawdiReference,
	parseClawdiReference,
	scanClawdiReferences,
} from "../src/lib/secret-references";

describe("clawdi secret references", () => {
	it("parses project-relative references", () => {
		expect(parseClawdiReference("clawdi://default/OPENAI_API_KEY")).toEqual({
			raw: "clawdi://default/OPENAI_API_KEY",
			vault: "default",
			section: "",
			field: "OPENAI_API_KEY",
			isExact: false,
		});
		expect(parseClawdiReference("clawdi://prod/openai/api_key")).toEqual({
			raw: "clawdi://prod/openai/api_key",
			vault: "prod",
			section: "openai",
			field: "api_key",
			isExact: false,
		});
		expect(parseClawdiReference("clawdi://project/OPENAI_API_KEY")).toEqual({
			raw: "clawdi://project/OPENAI_API_KEY",
			vault: "project",
			section: "",
			field: "OPENAI_API_KEY",
			isExact: false,
		});
	});

	it("parses exact project references", () => {
		expect(
			parseClawdiReference(
				"clawdi://project/00000000-0000-0000-0000-000000000123/vault/default/field/OPENAI_API_KEY",
			),
		).toEqual({
			raw: "clawdi://project/00000000-0000-0000-0000-000000000123/vault/default/field/OPENAI_API_KEY",
			project: "00000000-0000-0000-0000-000000000123",
			vault: "default",
			section: "",
			field: "OPENAI_API_KEY",
			isExact: true,
		});
		expect(
			parseClawdiReference("clawdi://project/engineering/vault/prod/section/openai/field/api_key"),
		).toEqual({
			raw: "clawdi://project/engineering/vault/prod/section/openai/field/api_key",
			project: "engineering",
			vault: "prod",
			section: "openai",
			field: "api_key",
			isExact: true,
		});
	});

	it("builds exact references with percent-encoded resource parts", () => {
		const reference = buildExactClawdiReference(
			"00000000-0000-0000-0000-000000000123",
			"prod vault",
			"api/providers",
			"OPENAI API KEY",
		);

		expect(reference).toBe(
			"clawdi://project/00000000-0000-0000-0000-000000000123/vault/prod%20vault/section/api%2Fproviders/field/OPENAI%20API%20KEY",
		);
		expect(parseClawdiReference(reference)).toEqual({
			raw: reference,
			project: "00000000-0000-0000-0000-000000000123",
			vault: "prod vault",
			section: "api/providers",
			field: "OPENAI API KEY",
			isExact: true,
		});
	});

	it("scans exact and relative references from templates", () => {
		const refs = scanClawdiReferences(
			[
				"OPENAI_API_KEY=clawdi://project/00000000-0000-0000-0000-000000000123/vault/default/field/OPENAI_API_KEY",
				"STRIPE_SECRET_KEY=clawdi://prod/stripe/secret_key",
			].join("\n"),
		);

		expect(refs.map((ref) => ref.raw)).toEqual([
			"clawdi://project/00000000-0000-0000-0000-000000000123/vault/default/field/OPENAI_API_KEY",
			"clawdi://prod/stripe/secret_key",
		]);
	});
});
