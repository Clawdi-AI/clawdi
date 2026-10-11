import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Contract = {
	schemaVersion: string;
	required: readonly string[];
	source: string;
	sample: Record<string, unknown>;
};

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const desktopParser = readFileSync(join(cliRoot, "../../apps/desktop/src/native-cli.ts"), "utf8");

/**
 * Desktop parses these fields today. Keep this table additive: a breaking
 * change needs a new schema version and a Desktop minimum-version bump.
 */
const contracts: readonly Contract[] = [
	{
		schemaVersion: "clawdi.desktopSession.v1",
		required: ["status", "expiresIn", "accountId"],
		source: "src/commands/auth.ts",
		sample: { status: "ticket", ticket: "ticket", expiresIn: 60, accountId: "user" },
	},
	{
		schemaVersion: "clawdi.desktopSignOut.v1",
		required: ["status"],
		source: "src/commands/auth.ts",
		sample: { status: "revoked" },
	},
	{
		schemaVersion: "clawdi.agentDetection.v1",
		required: ["agents"],
		source: "src/commands/agent-detect.ts",
		sample: {
			agents: [
				{
					type: "codex",
					displayName: "Codex",
					detected: true,
					registered: false,
					version: null,
					inspection: "complete",
				},
			],
		},
	},
	{
		schemaVersion: "clawdi.agentReconnectCandidates.v1",
		required: ["agents"],
		source: "src/commands/agent-reconnect.ts",
		sample: {
			agents: [
				{
					id: "agent",
					type: "codex",
					displayName: "Codex",
					name: "Workstation",
					machineName: "Mac",
					isThisMachine: true,
					lastSyncAt: null,
				},
			],
		},
	},
	{
		schemaVersion: "clawdi.config.v1",
		required: ["values"],
		source: "src/commands/config.ts",
		sample: { values: {} },
	},
	{
		schemaVersion: "clawdi.desktopLogin.progress.v1",
		required: ["verificationUri", "userCode", "expiresAt"],
		source: "src/commands/auth.ts",
		sample: {
			verificationUri: "https://accounts.clawdi.ai/device",
			userCode: "ABCD-EFGH",
			expiresAt: "2099-01-01T00:00:00.000Z",
		},
	},
	{
		schemaVersion: "clawdi.desktopLogin.v1",
		required: ["status"],
		source: "src/commands/auth.ts",
		sample: { status: "cancelled" },
	},
	{
		schemaVersion: "clawdi.authStatus.v1",
		required: ["authenticated"],
		source: "src/commands/auth.ts",
		sample: { authenticated: false, source: "none" },
	},
	{
		schemaVersion: "clawdi.daemonDoctor.v2",
		required: ["cli_version", "singleton_unit_installed", "singleton_unit_running", "agents"],
		source: "src/commands/serve.ts",
		sample: {
			cli_version: "1.2.3",
			singleton_unit_installed: false,
			singleton_unit_running: false,
			agents: [],
		},
	},
];

describe("Desktop JSON contracts", () => {
	it("keeps every Desktop-parsed schema and producer present", () => {
		for (const contract of contracts) {
			expect(desktopParser).toContain(contract.schemaVersion);
			expect(readFileSync(join(cliRoot, contract.source), "utf8")).toContain(
				contract.schemaVersion,
			);
		}
	});

	it("pins required fields while allowing additive output fields", () => {
		for (const contract of contracts) {
			expect(contract.schemaVersion).toMatch(/^clawdi(?:\.[A-Za-z]+)+\.v\d+$/);
			for (const field of contract.required) {
				expect(contract.sample).toHaveProperty(field);
			}
		}
	});
});
