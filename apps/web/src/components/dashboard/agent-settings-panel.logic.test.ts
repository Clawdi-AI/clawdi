import { describe, expect, test } from "bun:test";
import { syncAgentNameDraft } from "./agent-settings-panel.logic";

describe("syncAgentNameDraft", () => {
	test("initializes a draft from the server", () => {
		expect(syncAgentNameDraft("", undefined, "Research agent")).toBe("Research agent");
	});

	test("updates an untouched draft when the server name changes", () => {
		expect(syncAgentNameDraft("Research agent", "Research agent", "Build agent")).toBe(
			"Build agent",
		);
	});

	test("preserves an edited draft across unrelated agent cache updates", () => {
		expect(syncAgentNameDraft("Unsaved name", "Research agent", "Research agent")).toBe(
			"Unsaved name",
		);
		expect(syncAgentNameDraft("Unsaved name", "Research agent", "Externally renamed")).toBe(
			"Unsaved name",
		);
	});
});
