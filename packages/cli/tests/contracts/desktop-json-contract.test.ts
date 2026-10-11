import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DesktopAuthenticationProgress } from "@clawdi/shared/desktop";
import { type CommandResult, runCommand } from "../../../../apps/desktop/src/command-runner";
import { DesktopCliService } from "../../../../apps/desktop/src/native-cli";
import { getCliVersion } from "../../src/lib/version";

const roots: string[] = [];
const logs = ["info", "warn"] as const;
const logSpies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
	for (const method of logs) logSpies.push(spyOn(console, method).mockImplementation(() => {}));
});
afterEach(() => {
	for (const spy of logSpies.splice(0)) spy.mockRestore();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Mutation = (value: Record<string, unknown>) => void;
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected a JSON object");
	return value as Record<string, unknown>;
}

function fixture(scenario = "success") {
	const root = mkdtempSync(join(tmpdir(), "desktop-json-contract-"));
	roots.push(root);
	const home = join(root, "home");
	const bundled = join(root, "resources/native");
	mkdirSync(home);
	mkdirSync(bundled, { recursive: true });
	writeFileSync(join(bundled, process.platform === "win32" ? "clawdi.exe" : "clawdi"), "fixture");
	const outputs = new Map<string, CommandResult>();
	const mutations = new Map<string, Mutation>();
	const failures = new Map<string, string>();
	const progressMutations: Mutation[] = [];
	const execute: typeof runCommand = async (_command, args, options) => {
		const name = args.slice(0, 2).join(" ");
		if (name === "update --native-bootstrap") throw new Error("Fixture uses bundled CLI");
		if (name === "update --native-identity")
			return { stdout: `${getCliVersion()}\t${process.platform}-${process.arch}\n`, stderr: "" };
		let output = outputs.get(name);
		if (!output) {
			// Real argv dispatch and stdout generation, with a private home and only
			// network, browser, agent executables and OS services replaced.
			const diagnostics: string[] = [];
			output = await runCommand(
				process.execPath,
				[
					"--preload",
					resolve(import.meta.dir, "../fixtures/desktop-json-preload.ts"),
					resolve(import.meta.dir, "../../src/index.ts"),
					...args,
				],
				{
					env: {
						PATH: process.env.PATH,
						HOME: home,
						USERPROFILE: home,
						CLAWDI_HOME: join(home, ".clawdi"),
						CLAWDI_API_URL: "https://api.contract.test",
						CLAWDI_DEPLOY_API_URL: "https://deploy.contract.test",
						CLAWDI_NO_AUTO_UPDATE: "1",
						CLAWDI_NO_UPDATE_CHECK: "1",
						CLAWDI_CONTRACT_SCENARIO: scenario,
					},
					timeoutMs: 15_000,
					onStderrLine: (line) => diagnostics.push(line),
				},
			).catch((cause) => {
				failures.set(name, diagnostics.join("\n"));
				throw new Error(`Producer ${name} failed: ${diagnostics.join("\n")}`, { cause });
			});
			outputs.set(name, output);
		}
		for (const line of output.stderr.split("\n")) {
			if (!line.startsWith("{")) continue;
			const value = record(JSON.parse(line));
			if (value.schemaVersion !== "clawdi.desktopLogin.progress.v1") continue;
			for (const mutate of progressMutations) mutate(value);
			options?.onStderrLine?.(JSON.stringify(value));
		}
		const mutate = mutations.get(name);
		if (!mutate) return output;
		const value = record(JSON.parse(output.stdout));
		mutate(value);
		return { ...output, stdout: JSON.stringify(value) };
	};
	const service = new DesktopCliService(
		{ isPackaged: false, getAppPath: () => root, getPath: () => root, getVersion: () => "1.0.0" },
		execute,
		join(root, "resources"),
		home,
	);
	return { service, outputs, mutations, progressMutations, failures };
}

const additive: Mutation = (value) => {
	value.futureField = { compatible: true };
};
const missing =
	(field: string): Mutation =>
	(value) => {
		delete value[field];
	};

// Each mutation starts from stdout emitted by the real CLI; there are no sample envelopes.
describe("real CLI producers → Desktop consumers", () => {
	test("session ticket, existing session and account switch shapes", async () => {
		for (const [scenario, status] of [
			["success", "ticket"],
			["session-signed-in", "signed-in"],
			["session-sign-out", "sign-out"],
		]) {
			const { service, mutations } = fixture(scenario);
			const result = await service.createDashboardSession();
			expect(result.status).toBe(status);
			expect(result.accountId).toBe("contract-user");
			mutations.set("auth desktop-session", additive);
			expect(await service.createDashboardSession()).toEqual(result);
			for (const field of [
				"schemaVersion",
				"status",
				"accountId",
				"expiresIn",
				...(status === "ticket" ? ["ticket"] : []),
			]) {
				mutations.set("auth desktop-session", missing(field));
				await expect(service.createDashboardSession()).rejects.toThrow();
			}
		}
	});

	test("session revocation uses the actual sign-out producer", async () => {
		const { service, mutations } = fixture();
		await service.revokeDashboardSession("sess_contract");
		mutations.set("auth desktop-sign-out", additive);
		await service.revokeDashboardSession("sess_contract");
		for (const field of ["schemaVersion", "status"]) {
			mutations.set("auth desktop-sign-out", missing(field));
			await expect(service.revokeDashboardSession("sess_contract")).rejects.toThrow();
		}
	});

	test.each(["success", "inspection-failed"])(
		"agent detection (%s), including real adapter failure handling",
		async (scenario) => {
			const { service, mutations } = fixture(scenario);
			const agents = await service.detectAgents();
			expect(agents.length).toBeGreaterThan(0);
			expect(agents.find((agent) => agent.type === "codex")?.inspection).toBe(
				scenario === "inspection-failed" ? "failed" : "complete",
			);
			mutations.set("agent detect", additive);
			expect(await service.detectAgents()).toEqual(agents);
			mutations.set("agent detect", missing("agents"));
			await expect(service.detectAgents()).rejects.toThrow();
			for (const field of ["type", "displayName", "inspection"]) {
				mutations.set("agent detect", (value) => {
					if (!Array.isArray(value.agents)) throw new Error("Missing agents");
					delete record(value.agents[0])[field];
				});
				await expect(service.detectAgents()).rejects.toThrow();
			}
		},
	);

	test("reconnect candidates and config reach their real Desktop adapters", async () => {
		const { service, mutations } = fixture();
		const agents = await service.listReconnectableAgents();
		expect(agents[0]?.name).toBe("Workstation");
		mutations.set("agent reconnect", additive);
		expect(await service.listReconnectableAgents()).toEqual(agents);
		for (const field of [
			"id",
			"type",
			"displayName",
			"name",
			"machineName",
			"isThisMachine",
			"lastSyncAt",
		]) {
			mutations.set("agent reconnect", (value) => {
				if (!Array.isArray(value.agents)) throw new Error("Missing agents");
				delete record(value.agents[0])[field];
			});
			await expect(service.listReconnectableAgents()).rejects.toThrow();
		}
		expect(await service.listExcludedProjects()).toEqual(["/contract/project"]);
		mutations.set("config list", additive);
		expect(await service.listExcludedProjects()).toEqual(["/contract/project"]);
		for (const field of ["schemaVersion", "values"]) {
			mutations.set("config list", missing(field));
			await expect(service.listExcludedProjects()).rejects.toThrow();
		}
	});

	test.each(["success", "signed-out"])(
		"auth status and daemon doctor bootstrap (%s)",
		async (scenario) => {
			const { service, mutations } = fixture(scenario);
			const state = await service.bootstrapState();
			expect(state.auth.authenticated).toBe(scenario !== "signed-out");
			expect(state.auth.user?.id ?? null).toBe(scenario === "signed-out" ? null : "contract-user");
			expect(state.daemon).toEqual({ installed: false, running: false });
			for (const name of ["auth status", "daemon doctor"]) mutations.set(name, additive);
			expect(await service.bootstrapState()).toEqual(state);
			for (const [name, field] of [
				["auth status", "schemaVersion"],
				["daemon doctor", "schemaVersion"],
				["daemon doctor", "cli_version"],
			]) {
				mutations.clear();
				mutations.set(name, missing(field));
				await expect(service.bootstrapState()).rejects.toThrow();
			}
		},
	);

	test.each(["login-success", "login-cancelled"])(
		"Desktop login result and streamed progress (%s)",
		async (scenario) => {
			const { service, mutations, progressMutations } = fixture(scenario);
			const progress: DesktopAuthenticationProgress[] = [];
			const result = await service.authenticate((value) => progress.push(value));
			expect(result.status).toBe(scenario === "login-success" ? "authenticated" : "cancelled");
			expect(progress).toHaveLength(1);
			expect(progress[0]?.userCode).toBe("ABCD-EFGH");
			mutations.set("auth login", additive);
			progressMutations.push(additive);
			expect(await service.authenticate()).toEqual(result);
			for (const field of [
				"schemaVersion",
				"status",
				...(scenario === "login-success" ? ["user"] : []),
			]) {
				mutations.set("auth login", missing(field));
				await expect(service.authenticate()).rejects.toThrow();
			}
			mutations.clear();
			for (const field of ["verificationUri", "userCode", "expiresAt"]) {
				progressMutations.splice(0, progressMutations.length, missing(field));
				await expect(service.authenticate()).rejects.toThrow();
			}
		},
	);

	test.each(["signed-out", "session-failed"])(
		"session errors fail in the real command and remain sanitized in Desktop (%s)",
		async (scenario) => {
			const { service, outputs, failures } = fixture(scenario);
			await expect(service.createDashboardSession()).rejects.toThrow(
				"Couldn't create a Desktop session",
			);
			expect(outputs.has("auth desktop-session")).toBe(false);
			expect(failures.get("auth desktop-session")).toContain(
				scenario === "signed-out" ? "requires Clerk OAuth" : "Couldn't create a Desktop session",
			);
		},
	);

	test("failed OAuth is rejected by the real Desktop authentication adapter", async () => {
		const { service, failures } = fixture("login-failed");
		await expect(service.authenticate()).rejects.toThrow();
		expect(failures.get("auth login")).toContain("sign-in could not be completed");
	});
});
