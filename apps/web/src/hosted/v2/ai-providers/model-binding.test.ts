import { describe, expect, test } from "bun:test";
import {
	firstModelForProvider,
	MANAGED_AI_CHOICE,
	MANAGED_PRIMARY_MODEL_FALLBACK,
} from "@/hosted/v2/ai-providers/model-binding";

describe("model binding", () => {
	test("uses the served managed model as the fallback", () => {
		expect(MANAGED_PRIMARY_MODEL_FALLBACK).toBe("gpt-5.5");
		expect(firstModelForProvider(MANAGED_AI_CHOICE, [])).toBe("gpt-5.5");
	});
});
