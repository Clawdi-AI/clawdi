import { describe, expect, it } from "bun:test";
import {
	agentDisconnectUnavailable,
	agentOwnershipKindFromId,
	EMPTY_AGENT_OWNERSHIP,
} from "@/lib/agent-ownership";

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
		// Cosmetic fallback only — destructive consumers (Disconnect) must
		// additionally require a non-null (resolved) ownership value.
		expect(agentOwnershipKindFromId("aaaa", null)).toBe("connected");
		expect(agentOwnershipKindFromId(null, null)).toBe("connected");
	});

	it("resolved empty ownership classifies everything as connected", () => {
		expect(agentOwnershipKindFromId("aaaa", EMPTY_AGENT_OWNERSHIP)).toBe("connected");
	});

	it("prefers cloud when both sets contain the same environment", () => {
		const ownership = {
			cloudEnvIds: new Set(["aaaa"]),
			legacyEnvIds: new Set(["aaaa"]),
		};

		expect(agentOwnershipKindFromId("aaaa", ownership)).toBe("cloud");
	});
});

describe("agentDisconnectUnavailable", () => {
	it("keeps connected machine-key agents disconnectable after ownership resolves", () => {
		expect(
			agentDisconnectUnavailable({
				envId: "aaaa",
				explicitIdentity: false,
				ownership: EMPTY_AGENT_OWNERSHIP,
			}),
		).toBe(false);
	});

	it("treats an absent explicit identity field as the existing connected behavior", () => {
		expect(
			agentDisconnectUnavailable({
				envId: "aaaa",
				ownership: EMPTY_AGENT_OWNERSHIP,
			}),
		).toBe(false);
	});

	it("blocks disconnect for explicit-identity agents outside ownership sets", () => {
		expect(
			agentDisconnectUnavailable({
				envId: "aaaa",
				explicitIdentity: true,
				ownership: EMPTY_AGENT_OWNERSHIP,
			}),
		).toBe(true);
	});

	it("blocks disconnect while ownership is unresolved or externally owned", () => {
		expect(
			agentDisconnectUnavailable({
				envId: "aaaa",
				explicitIdentity: false,
				ownership: null,
			}),
		).toBe(true);
		expect(
			agentDisconnectUnavailable({
				envId: "aaaa",
				explicitIdentity: false,
				ownership: { cloudEnvIds: new Set(["aaaa"]), legacyEnvIds: new Set() },
			}),
		).toBe(true);
	});
});
