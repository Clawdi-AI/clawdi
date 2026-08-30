import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMPTY_AGENT_OWNERSHIP } from "@clawdi/shared/client";
import {
	syncAgentNameDraft,
	webAgentDisconnectUnavailable,
} from "./agent-settings-panel.logic";

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

describe("webAgentDisconnectUnavailable", () => {
	test("preserves the connected machine-key action", () => {
		expect(
			webAgentDisconnectUnavailable({
				agentId: "agent-id",
				explicitIdentity: false,
				ownership: EMPTY_AGENT_OWNERSHIP,
			}),
		).toBe(false);
	});

	test("keeps destructive access closed until ownership is safe", () => {
		expect(
			webAgentDisconnectUnavailable({
				agentId: "agent-id",
				explicitIdentity: true,
				ownership: EMPTY_AGENT_OWNERSHIP,
			}),
		).toBe(true);
		expect(
			webAgentDisconnectUnavailable({
				agentId: "agent-id",
				explicitIdentity: false,
				ownership: null,
			}),
		).toBe(true);
	});
});

describe("Agent disconnect navigation", () => {
	test("refreshes related collections and returns to the Agents list", () => {
		const source = readFileSync(new URL("./agent-settings-panel.tsx", import.meta.url), "utf8");

		expect(source).toContain('invalidateQueries({ queryKey: ["get", "/v1/agents"] })');
		expect(source).toContain('invalidateQueries({ queryKey: ["get", "/v1/projects"] })');
		expect(source).toContain('invalidateQueries({ queryKey: ["get", "/v1/vault"] })');
		expect(source).toContain('router.navigate({ href: "/agents" })');
	});
});
