import { describe, expect, test } from "bun:test";
import {
	agentDisconnectEligibility,
	agentOwnershipKindFromId,
	EMPTY_AGENT_OWNERSHIP,
	PLATFORM_CAPABILITIES,
} from "./client";

describe("platform capabilities", () => {
	test("makes local, hosted, and billing platform differences explicit", () => {
		expect(PLATFORM_CAPABILITIES.web.localAgentSetup).toBe("handoff");
		expect(PLATFORM_CAPABILITIES.desktop.localAgentInventory).toBe("direct");
		expect(PLATFORM_CAPABILITIES.mobile.localAgentInventory).toBe("unsupported");
		expect(PLATFORM_CAPABILITIES.mobile.hostedAgentLifecycle).toBe("direct");
		expect(PLATFORM_CAPABILITIES.mobile.billing).toBe("policy-gated");
	});
});

describe("Agent ownership", () => {
	const ownership = {
		cloudAgentIds: new Set(["cloud-id"]),
		legacyAgentIds: new Set(["legacy-id"]),
		isResolved: true,
	};
	const partialOwnership = {
		cloudAgentIds: new Set(["cloud-id"]),
		legacyAgentIds: new Set<string>(),
		isResolved: false,
	};

	test("normalizes ids and classifies known ownership", () => {
		expect(agentOwnershipKindFromId(" CLOUD-ID ", ownership)).toBe("cloud");
		expect(agentOwnershipKindFromId("LEGACY-ID", ownership)).toBe("legacy");
		expect(agentOwnershipKindFromId("connected-id", ownership)).toBe("connected");
	});

	test("projects missing ids from ownership resolution without guessing", () => {
		for (const agentId of [null, undefined, "", "   "] as const) {
			expect(agentOwnershipKindFromId(agentId, EMPTY_AGENT_OWNERSHIP)).toBe("connected");
			expect(agentOwnershipKindFromId(agentId, partialOwnership)).toBe("unresolved");
			expect(agentOwnershipKindFromId(agentId, null)).toBe("unresolved");
		}
	});

	test("retains known partial ownership and gives Cloud precedence", () => {
		expect(agentOwnershipKindFromId("cloud-id", partialOwnership)).toBe("cloud");
		expect(
			agentOwnershipKindFromId("shared-id", {
				cloudAgentIds: new Set(["shared-id"]),
				legacyAgentIds: new Set(["shared-id"]),
				isResolved: true,
			}),
		).toBe("cloud");
	});
});

describe("agentDisconnectEligibility", () => {
	test("allows supported clients to disconnect, including when explicit identity is absent", () => {
		const cases = [
			{ platform: "web", explicitIdentity: false },
			{ platform: "web" },
			{ platform: "desktop", explicitIdentity: false },
		] as const;
		for (const input of cases) {
			expect(
				agentDisconnectEligibility({
					...input,
					agentId: "agent-id",
					ownership: EMPTY_AGENT_OWNERSHIP,
				}),
			).toEqual({ eligible: true });
		}
	});

	test("keeps the action off Mobile", () => {
		expect(
			agentDisconnectEligibility({
				platform: "mobile",
				agentId: "agent-id",
				ownership: EMPTY_AGENT_OWNERSHIP,
			}),
		).toEqual({ eligible: false, reason: "platform_unsupported" });
	});

	test("denies explicit identities", () => {
		expect(
			agentDisconnectEligibility({
				platform: "web",
				agentId: "agent-id",
				explicitIdentity: true,
				ownership: EMPTY_AGENT_OWNERSHIP,
			}),
		).toEqual({ eligible: false, reason: "explicit_identity" });
	});

	test("fails closed for unresolved and externally managed ownership", () => {
		const cases = [
			{
				agentId: "agent-id",
				ownership: null,
				expected: { eligible: false, reason: "ownership_unresolved" },
			},
			{
				agentId: "agent-id",
				ownership: {
					cloudAgentIds: new Set<string>(),
					legacyAgentIds: new Set<string>(),
					isResolved: false,
				},
				expected: { eligible: false, reason: "ownership_unresolved" },
			},
			{
				agentId: "agent-id",
				ownership: {
					cloudAgentIds: new Set(["agent-id"]),
					legacyAgentIds: new Set<string>(),
					isResolved: true,
				},
				expected: { eligible: false, reason: "externally_managed" },
			},
			{
				agentId: "agent-id",
				ownership: {
					cloudAgentIds: new Set<string>(),
					legacyAgentIds: new Set(["agent-id"]),
					isResolved: true,
				},
				expected: { eligible: false, reason: "externally_managed" },
			},
		] as const;

		for (const { agentId, ownership, expected } of cases) {
			expect(agentDisconnectEligibility({ platform: "web", agentId, ownership })).toEqual(expected);
		}
	});
});
