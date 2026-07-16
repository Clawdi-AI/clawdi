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
			isResolved: true,
		};

		expect(agentOwnershipKindFromId("AAAA", ownership)).toBe("cloud");
		expect(agentOwnershipKindFromId("bbbb", ownership)).toBe("legacy");
		expect(agentOwnershipKindFromId("cccc", ownership)).toBe("connected");
	});

	it("trims environment ids and treats missing ids as connected for cosmetic callers", () => {
		const ownership = {
			cloudEnvIds: new Set(["aaaa"]),
			legacyEnvIds: new Set(["bbbb"]),
			isResolved: true,
		};

		expect(agentOwnershipKindFromId("  AAAA  ", ownership)).toBe("cloud");
		expect(agentOwnershipKindFromId("  BBBB  ", ownership)).toBe("legacy");

		for (const envId of [null, undefined, "", "   "]) {
			expect(agentOwnershipKindFromId(envId, ownership)).toBe("connected");
		}
	});

	it("preserves unresolved ownership instead of guessing connected", () => {
		expect(agentOwnershipKindFromId("aaaa", null)).toBe("unresolved");
		expect(agentOwnershipKindFromId(null, null)).toBe("unresolved");
	});

	it("resolved empty ownership classifies everything as connected", () => {
		expect(agentOwnershipKindFromId("aaaa", EMPTY_AGENT_OWNERSHIP)).toBe("connected");
	});

	it("retains known ownership while leaving unknown ids unresolved from a stale snapshot", () => {
		const ownership = {
			cloudEnvIds: new Set(["aaaa"]),
			legacyEnvIds: new Set(["bbbb"]),
			isResolved: false,
		};

		expect(agentOwnershipKindFromId("aaaa", ownership)).toBe("cloud");
		expect(agentOwnershipKindFromId("bbbb", ownership)).toBe("legacy");
		expect(agentOwnershipKindFromId("cccc", ownership)).toBe("unresolved");
	});

	it("prefers cloud when both sets contain the same environment", () => {
		const ownership = {
			cloudEnvIds: new Set(["aaaa"]),
			legacyEnvIds: new Set(["aaaa"]),
			isResolved: true,
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

	it("fails closed while ownership is unresolved for edge environment ids", () => {
		for (const envId of ["aaaa", null, undefined, "", "   "]) {
			expect(
				agentDisconnectUnavailable({
					envId,
					explicitIdentity: false,
					ownership: null,
				}),
			).toBe(true);
		}
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
				ownership: {
					cloudEnvIds: new Set(["aaaa"]),
					legacyEnvIds: new Set(),
					isResolved: true,
				},
			}),
		).toBe(true);
		expect(
			agentDisconnectUnavailable({
				envId: "aaaa",
				explicitIdentity: false,
				ownership: {
					cloudEnvIds: new Set(),
					legacyEnvIds: new Set(["aaaa"]),
					isResolved: true,
				},
			}),
		).toBe(true);
	});
});
