import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopAgentType } from "@clawdi/shared/desktop";
import { ApiError } from "../lib/api-client";
import { setAuth } from "../lib/config";
import { detectLocalAgents, inspectDesktopRegistration } from "./agent-detect";

const originalClawdiHome = process.env.CLAWDI_HOME;
const roots: string[] = [];

afterEach(() => {
	if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = originalClawdiHome;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entry(
	type: DesktopAgentType,
	detect: () => Promise<boolean>,
	getVersion: () => Promise<string | null> = async () => null,
) {
	return {
		agentType: type,
		displayName: type,
		create: () => ({ detect, getVersion }),
	};
}

describe("desktop agent detection", () => {
	test("reports usable, absent, and unreadable adapters without aborting the scan", async () => {
		const agents = await detectLocalAgents(
			[
				entry(
					"claude_code",
					async () => true,
					async () => "1.2.3",
				),
				entry("codex", async () => false),
				entry("openclaw", async () => {
					throw new Error("private path");
				}),
			],
			{ registeredTypes: new Set(["claude_code"]) },
		);

		expect(agents).toEqual([
			{
				type: "claude_code",
				displayName: "claude_code",
				detected: true,
				registered: true,
				version: "1.2.3",
				inspection: "complete",
			},
			{
				type: "codex",
				displayName: "codex",
				detected: false,
				registered: false,
				version: null,
				inspection: "complete",
			},
			{
				type: "openclaw",
				displayName: "openclaw",
				detected: false,
				registered: false,
				version: null,
				inspection: "failed",
			},
		]);
	});

	test.each([
		["owned", "registered", true, "complete"],
		["missing", "not_registered", false, "complete"],
		["offline", "failed", false, "failed"],
	] as const)(
		"inspects a legacy registration with a %s cloud result",
		async (cloudResult, expectedStatus, registered, inspection) => {
			const root = mkdtempSync(join(tmpdir(), "clawdi-agent-detect-"));
			roots.push(root);
			process.env.CLAWDI_HOME = root;
			mkdirSync(join(root, "environments"), { recursive: true });
			const registrationPath = join(root, "environments", "codex.json");
			writeFileSync(
				registrationPath,
				`${JSON.stringify({ id: "agent-a", agentType: "codex", machineId: "machine-a" })}\n`,
			);
			setAuth({ apiKey: "account-b-key", userId: "account-b" });
			const before = readFileSync(registrationPath, "utf8");
			const lookup = async () => {
				if (cloudResult === "missing") {
					throw new ApiError({ status: 404, body: "", hint: "" });
				}
				if (cloudResult === "offline") throw new Error("network unavailable");
			};

			const agents = await detectLocalAgents([entry("codex", async () => true)], {
				registeredTypes: new Set(["codex"]),
				inspectRegistration: (agentType) => inspectDesktopRegistration(agentType, lookup),
			});

			expect(agents[0]).toMatchObject({ registered, inspection });
			const after = readFileSync(registrationPath, "utf8");
			if (expectedStatus === "registered") {
				expect(JSON.parse(after)).toMatchObject({ id: "agent-a", userId: "account-b" });
			} else {
				expect(after).toBe(before);
			}
		},
	);
});
