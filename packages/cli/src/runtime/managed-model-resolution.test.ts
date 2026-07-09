import { describe, expect, test } from "bun:test";
import {
	buildManagedModelsEndpoint,
	extractManagedLiveModelIds,
	resolveManagedPrimaryModel,
} from "./managed-model-resolution";

describe("managed model resolution", () => {
	test("keeps a configured managed model when it is still live", () => {
		expect(
			resolveManagedPrimaryModel({
				seedModel: "gpt-5.5",
				liveModelIds: ["gpt-5.4", "gpt-5.5", "gpt-5.6"],
			}),
		).toEqual({
			resolvedModel: "gpt-5.5",
			reason: "kept_valid_seed",
		});
	});

	test("upgrades an invalid or absent managed seed to the latest live model", () => {
		expect(
			resolveManagedPrimaryModel({
				seedModel: "gpt-5.4",
				liveModelIds: ["gpt-5.5", "gpt-5.6", "gpt-5.6-pro"],
			}),
		).toEqual({
			resolvedModel: "gpt-5.6-pro",
			reason: "upgraded_to_latest",
		});

		expect(
			resolveManagedPrimaryModel({
				seedModel: null,
				liveModelIds: ["gpt-5.5", "gpt-5.6"],
			}),
		).toEqual({
			resolvedModel: "gpt-5.6",
			reason: "upgraded_to_latest",
		});
	});

	test("keeps the existing seed when the live fetch fails", () => {
		expect(
			resolveManagedPrimaryModel({
				seedModel: "gpt-5.5",
				liveModelIds: null,
			}),
		).toEqual({
			resolvedModel: "gpt-5.5",
			reason: "kept_seed_after_fetch_failure",
		});
	});

	test("builds the managed OpenAI-compatible /v1/models endpoint and parses live ids", () => {
		expect(buildManagedModelsEndpoint("https://api.example.test/v1/")).toBe(
			"https://api.example.test/v1/models",
		);
		expect(
			extractManagedLiveModelIds({
				data: [{ id: "gpt-5.5" }, { id: "gpt-5.6" }, { id: "gpt-5.6" }, { bad: true }],
			}),
		).toEqual(["gpt-5.5", "gpt-5.6"]);
	});
});
