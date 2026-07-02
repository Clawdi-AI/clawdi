import { describe, expect, it } from "bun:test";
import { agentOwnershipKindFromId } from "@/lib/agent-ownership";

describe("agentOwnershipKindFromId", () => {
	it("classifies environments from ownership sets with case-insensitive ids", () => {
		const ownership = {
			cloudEnvIds: new Set(["aaaa"]),
			legacyEnvIds: new Set(["bbbb"]),
		};

		expect(agentOwnershipKindFromId("AAAA", ownership)).toBe("cloud");
		expect(agentOwnershipKindFromId("bbbb", ownership)).toBe("legacy");
		expect(agentOwnershipKindFromId("cccc", ownership)).toBe("connected");
	});

	it("defaults to connected while ownership is unknown", () => {
		expect(agentOwnershipKindFromId("aaaa", null)).toBe("connected");
		expect(agentOwnershipKindFromId(null, null)).toBe("connected");
	});

	it("prefers cloud when both sets contain the same environment", () => {
		const ownership = {
			cloudEnvIds: new Set(["aaaa"]),
			legacyEnvIds: new Set(["aaaa"]),
		};

		expect(agentOwnershipKindFromId("aaaa", ownership)).toBe("cloud");
	});
});
