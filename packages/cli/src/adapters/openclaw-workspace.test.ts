import { afterEach, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApiClient } from "../lib/api-client";
import {
	computeSkillFolderHash,
	readProjectSkillMaterialization,
	recordProjectSkillMaterialization,
	recordSkillProjectionClaim,
} from "../lib/skills-lock";
import { computeSkillArchiveHash, tarSingleFile } from "../lib/tar";
import * as managedSkillDelivery from "../runtime/managed-skill-delivery";
import * as managedSkillReservation from "../runtime/managed-skill-reservation";
import { reconcileConnectedProjectSkills } from "../serve/project-skill-reconcile";
import { RetryQueue } from "../serve/queue";
import {
	reconcileAgentSkillProjection,
	reconcileAgentSkillProjectionListing,
} from "../serve/sync-engine";
import { OpenClawAdapter } from "./openclaw";
import {
	listOpenClawAgentWorkspaces,
	resolveOpenClawAgentWorkspace,
	resolveOpenClawAgentWorkspaceAsync,
} from "./openclaw-workspace";

const originalEnv = { ...process.env };
const originalPath = process.env.PATH;
let root = "";
afterEach(() => {
	process.env = { ...originalEnv };
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function installRosterCommand(status = 0): string {
	root = mkdtempSync(join(tmpdir(), "openclaw-workspace-"));
	const bin = join(root, "bin");
	const command = join(bin, "openclaw");
	const roster = join(root, "roster.json");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		command,
		`#!/bin/sh
test "$*" = "agents list --json" || exit 1
printf '.\\n' >> "${join(root, "calls")}"
cat "${roster}"
exit ${status}
`,
	);
	chmodSync(command, 0o755);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	return roster;
}

function rosterCalls(): number {
	return readFileSync(join(root, "calls"), "utf8").trim().split("\n").length;
}

test("Skills polls reuse a workspace within a reconcile cycle while reading current Skill keys", async () => {
	const roster = installRosterCommand();
	const workspace = join(root, "workspace");
	mkdirSync(join(workspace, "skills", "demo"), { recursive: true });
	writeFileSync(join(workspace, "skills", "demo", "SKILL.md"), "# Demo\n");
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	const skills = new OpenClawAdapter().skills;
	const context = { signal: new AbortController().signal, skillPollCycle: {} };
	expect(await skills.listKeys(context)).toEqual(["demo"]);
	for (let poll = 0; poll < 3; poll++) expect(await skills.listKeys(context)).toEqual(["demo"]);
	mkdirSync(join(workspace, "skills", "new"));
	writeFileSync(join(workspace, "skills", "new", "SKILL.md"), "# New\n");
	expect((await skills.listKeys(context)).sort()).toEqual(["demo", "new"]);
	expect(rosterCalls()).toBe(1);

	const nextWorkspace = join(root, "next-workspace");
	mkdirSync(nextWorkspace);
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
	const nextCycle = { ...context, skillPollCycle: {} };
	expect(await skills.listKeys(nextCycle)).toEqual([]);
	expect(await skills.listKeys(nextCycle)).toEqual([]);
	expect(rosterCalls()).toBe(2);
});

test("a failed polling resolution is retried on the next poll", async () => {
	const roster = installRosterCommand(1);
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace: root }]));
	const skills = new OpenClawAdapter().skills;
	const context = { signal: new AbortController().signal, skillPollCycle: {} };
	await expect(skills.listKeys(context)).rejects.toThrow("OpenClaw workspace resolution requires");
	expect(rosterCalls()).toBe(1);
	const command = join(root, "bin", "openclaw");
	writeFileSync(command, readFileSync(command, "utf8").replace(/\nexit 1\n$/, "\nexit 0\n"));
	expect(await skills.listKeys(context)).toEqual([]);
	expect(await skills.listKeys(context)).toEqual([]);
	expect(rosterCalls()).toBe(2);
});

test.each(["missing", "unreadable", "not a directory"])(
	"a %s cached workspace triggers fresh resolution",
	async (condition) => {
		const roster = installRosterCommand();
		const workspace = join(root, "workspace");
		const nextWorkspace = join(root, "next-workspace");
		mkdirSync(workspace);
		mkdirSync(nextWorkspace);
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
		const cycle = {};
		expect(await resolveOpenClawAgentWorkspaceAsync("main", undefined, cycle)).toBe(workspace);
		if (condition === "unreadable") chmodSync(workspace, 0o000);
		else rmSync(workspace, { recursive: true });
		if (condition === "not a directory") writeFileSync(workspace, "unreadable as a directory");
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
		try {
			expect(await resolveOpenClawAgentWorkspaceAsync("main", undefined, cycle)).toBe(
				nextWorkspace,
			);
			expect(await resolveOpenClawAgentWorkspaceAsync("main", undefined, cycle)).toBe(
				nextWorkspace,
			);
			expect(rosterCalls()).toBe(2);
		} finally {
			if (condition === "unreadable") chmodSync(workspace, 0o755);
		}
	},
);

test("one-shot Skills reads always resolve fresh even after a daemon poll", async () => {
	const roster = installRosterCommand();
	const workspace = join(root, "workspace");
	const nextWorkspace = join(root, "next-workspace");
	for (const path of [workspace, nextWorkspace]) {
		mkdirSync(join(path, "skills", "demo"), { recursive: true });
		writeFileSync(join(path, "skills", "demo", "SKILL.md"), "# Demo\n");
	}
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	const skills = new OpenClawAdapter().skills;
	const context = { signal: new AbortController().signal, skillPollCycle: {} };
	expect(await skills.listKeys(context)).toEqual(["demo"]);
	rmSync(join(workspace, "skills"), { recursive: true });
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
	expect(await skills.listKeys(context)).toEqual([]);
	expect(await skills.listKeys()).toEqual(["demo"]);
	expect(await skills.listKeys()).toEqual(["demo"]);
	expect((await skills.collect(context)).map((skill) => skill.filePath)).toEqual([
		join(nextWorkspace, "skills", "demo", "SKILL.md"),
	]);
	expect(rosterCalls()).toBe(4);
});

test("a fresh operation binds paths and reads once and seeds only the following polls", async () => {
	const roster = installRosterCommand();
	const workspace = join(root, "workspace");
	const nextWorkspace = join(root, "next-workspace");
	for (const path of [workspace, nextWorkspace]) {
		mkdirSync(join(path, "skills", "demo"), { recursive: true });
		writeFileSync(join(path, "skills", "demo", "SKILL.md"), "# Demo\n");
	}
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	const skills = new OpenClawAdapter().skills;
	const context = { signal: new AbortController().signal, skillPollCycle: {} };
	const operation = await skills.forOperation(context);
	expect(operation.rootDir()).toBe(join(workspace, "skills"));
	expect(operation.path("demo")).toBe(join(workspace, "skills", "demo", "SKILL.md"));
	expect(await operation.listKeys()).toEqual(["demo"]);
	expect((await operation.collect()).map((skill) => skill.skillKey)).toEqual(["demo"]);
	expect(await skills.listKeys(context)).toEqual(["demo"]);
	expect(rosterCalls()).toBe(1);

	writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
	const nextOperation = await skills.forOperation(context);
	expect(nextOperation.rootDir()).toBe(join(nextWorkspace, "skills"));
	expect(operation.rootDir()).toBe(join(workspace, "skills"));
	expect(await skills.listKeys(context)).toEqual(["demo"]);
	expect(rosterCalls()).toBe(2);
});

test("a moved native install target fails before touching the operation's old target", async () => {
	const roster = installRosterCommand();
	const workspace = join(root, "workspace");
	const nextWorkspace = join(root, "next-workspace");
	const oldSkill = join(workspace, "skills", "demo", "SKILL.md");
	mkdirSync(join(workspace, "skills", "demo"), { recursive: true });
	writeFileSync(oldSkill, "# Keep the old target\n");
	mkdirSync(nextWorkspace);
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	const operation = await new OpenClawAdapter().skills.forOperation();
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
	const mutation = spyOn(managedSkillReservation, "mutateUserSkillTarget");
	const verification = spyOn(managedSkillDelivery, "collectManagedSkillTree");
	const rollback = spyOn(managedSkillDelivery, "withManagedTargetRollback");
	try {
		await expect(operation.writeArchive("demo", Buffer.from("not an archive"))).rejects.toThrow(
			"OpenClaw agent workspace changed before Skill install",
		);
		expect(mutation).not.toHaveBeenCalled();
		expect(verification).not.toHaveBeenCalled();
		expect(rollback).not.toHaveBeenCalled();
		expect(readFileSync(oldSkill, "utf8")).toBe("# Keep the old target\n");
		expect(existsSync(join(nextWorkspace, "skills"))).toBe(false);
		expect(rosterCalls()).toBe(2);
	} finally {
		mutation.mockRestore();
		verification.mockRestore();
		rollback.mockRestore();
	}
});

test.each(["moved", "unavailable", "unchanged"])(
	"confirms all absences once after the Cloud listing wait: workspace %s",
	async (condition) => {
		const roster = installRosterCommand();
		process.env.HOME = root;
		process.env.CLAWDI_HOME = join(root, ".clawdi");
		process.env.CLAWDI_STATE_DIR = join(root, "serve");
		delete process.env.CLAWDI_RUNTIME_USER;
		delete process.env.OPENCLAW_AGENT_ID;
		const workspace = join(root, "workspace");
		const nextWorkspace = join(root, "next-workspace");
		const claims = new Map<string, string>();
		for (const skillKey of ["alpha", "beta"]) {
			const directory = join(workspace, "skills", skillKey);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "SKILL.md"), `# ${skillKey}\n`);
			const hash = await computeSkillFolderHash(directory, undefined, skillKey);
			claims.set(skillKey, hash);
			recordSkillProjectionClaim({
				agentType: "openclaw",
				agentId: "agent-test",
				projectId: "project-test",
				skillKey,
				hash,
			});
		}
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
		const skills = await new OpenClawAdapter().skills.forOperation();
		const queue = new RetryQueue({ agentType: "openclaw" });
		const input = {
			opts: { environmentId: "agent-test", adapter: { agentType: "openclaw" as const } },
			skills,
			queue,
			claims,
			projectId: "project-test",
		};
		let listingStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			listingStarted = resolve;
		});
		let releaseListing: () => void = () => {};
		const listingWait = new Promise<void>((resolve) => {
			releaseListing = resolve;
		});
		const api = new ApiClient({
			requireAuth: false,
			baseUrl: "https://cloud.example.test",
			fetch: async () => {
				listingStarted();
				await listingWait;
				return Response.json(
					{ items: [...claims.keys()].map((skill_key) => ({ skill_key })), total: 2 },
					{ headers: { ETag: '"1:project-test"' } },
				);
			},
		});
		try {
			// The first pass is idle, so it uses only the tick's initial roster read.
			await reconcileAgentSkillProjection(input);
			expect(queue.all()).toEqual([]);
			expect(rosterCalls()).toBe(1);
			const listing = reconcileAgentSkillProjectionListing({
				...input,
				api,
				previousEtag: null,
				forceComplete: true,
			});
			void listing.catch(() => {});
			await started;
			if (condition === "moved") {
				renameSync(workspace, nextWorkspace);
				writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
			} else {
				rmSync(join(workspace, "skills"), { recursive: true });
				if (condition === "unavailable") writeFileSync(roster, "[]");
			}
			releaseListing();
			if (condition === "unchanged") {
				await listing;
				expect(
					queue.all().map((item) => [item.kind, "skill_key" in item && item.skill_key]),
				).toEqual([
					["skill_delete", "alpha"],
					["skill_delete", "beta"],
				]);
			} else {
				await expect(listing).rejects.toThrow("OpenClaw");
				expect(queue.all()).toEqual([]);
			}
			expect(rosterCalls()).toBe(2);
		} finally {
			releaseListing();
			await queue.flushPersist();
		}
	},
);

test("a workspace move during Project download cannot fence a materialization receipt", async () => {
	const roster = installRosterCommand();
	process.env.HOME = root;
	process.env.CLAWDI_HOME = join(root, ".clawdi");
	delete process.env.CLAWDI_RUNTIME_USER;
	delete process.env.OPENCLAW_AGENT_ID;
	const workspace = join(root, "workspace");
	const nextWorkspace = join(root, "next-workspace");
	mkdirSync(workspace);
	mkdirSync(nextWorkspace);
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	const skills = await new OpenClawAdapter().skills.forOperation();
	const archive = await tarSingleFile("alpha", "# Desired Skill\n");
	const hash = await computeSkillArchiveHash(archive, "alpha");
	const archiveUrl = `https://cloud.example.test/v1/runtime/project-skill-archives/agent-test/project-test/skill-test/${hash}/alpha.tar.gz`;
	const api = new ApiClient({
		requireAuth: false,
		baseUrl: "https://cloud.example.test",
		fetch: async (request) =>
			request.method === "PUT"
				? new Response(null, { status: 204 })
				: Response.json({
						agent_id: "agent-test",
						skills: [
							{
								project_id: "project-test",
								skill_id: "skill-test",
								skill_key: "alpha",
								content_hash: hash,
								archive_url: archiveUrl,
							},
						],
					}),
	});
	const download = spyOn(api, "requestStream").mockImplementation(async () => {
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
		return new Response(Uint8Array.from(archive));
	});
	const lock = await import("../lib/skills-lock");
	const fence = spyOn(lock, "commitProjectSkillMaterialization");
	try {
		await expect(
			reconcileConnectedProjectSkills({
				api,
				agentId: "agent-test",
				agentType: "openclaw",
				skills,
			}),
		).rejects.toThrow("workspace changed during Skill operation");
		expect(download).toHaveBeenCalledTimes(1);
		expect(fence).not.toHaveBeenCalled();
		expect(
			readProjectSkillMaterialization({ agentType: "openclaw", localSkillKey: "alpha" }),
		).toBeNull();
		expect(existsSync(join(workspace, "skills"))).toBe(false);
		expect(existsSync(join(nextWorkspace, "skills"))).toBe(false);
		expect(rosterCalls()).toBe(2);
	} finally {
		fence.mockRestore();
		download.mockRestore();
	}
});

test.each(["moved", "unavailable", "missing old target", "unchanged"])(
	"confirms Project removal after its inventory wait: workspace %s",
	async (condition) => {
		const roster = installRosterCommand();
		process.env.HOME = root;
		process.env.CLAWDI_HOME = join(root, ".clawdi");
		delete process.env.CLAWDI_RUNTIME_USER;
		delete process.env.OPENCLAW_AGENT_ID;
		const workspace = join(root, "workspace");
		const nextWorkspace = join(root, "next-workspace");
		const directory = join(workspace, "skills", "alpha");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "SKILL.md"), "# Keep old target\n");
		recordProjectSkillMaterialization({
			agentType: "openclaw",
			localSkillKey: "alpha",
			sourceProjectId: "project-test",
			sourceSkillKey: "alpha",
			contentHash: await computeSkillFolderHash(directory, undefined, "alpha"),
			reconcileAgentId: "agent-test",
		});
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
		const skills = await new OpenClawAdapter().skills.forOperation();
		const mutation = spyOn(managedSkillReservation, "mutateUserSkillTarget");
		const api = new ApiClient({
			requireAuth: false,
			baseUrl: "https://cloud.example.test",
			fetch: async (request) => {
				if (request.method === "PUT") return new Response(null, { status: 204 });
				// Config changes while the tick is awaiting its Project inventory.
				if (condition === "missing old target") renameSync(workspace, nextWorkspace);
				if (condition === "moved" || condition === "missing old target") {
					mkdirSync(nextWorkspace, { recursive: true });
					writeFileSync(roster, JSON.stringify([{ id: "main", workspace: nextWorkspace }]));
				} else if (condition === "unavailable") writeFileSync(roster, "[]");
				return Response.json({ agent_id: "agent-test", skills: [] });
			},
		});
		try {
			const reconcile = reconcileConnectedProjectSkills({
				api,
				agentId: "agent-test",
				agentType: "openclaw",
				skills,
			});
			if (condition === "unchanged") {
				await reconcile;
				expect(existsSync(directory)).toBe(false);
				expect(mutation).toHaveBeenCalledTimes(1);
				expect(
					readProjectSkillMaterialization({ agentType: "openclaw", localSkillKey: "alpha" }),
				).toBeNull();
			} else {
				await expect(reconcile).rejects.toThrow("OpenClaw");
				expect(mutation).not.toHaveBeenCalled();
				expect(
					readProjectSkillMaterialization({ agentType: "openclaw", localSkillKey: "alpha" }),
				).not.toBeNull();
				const retained = condition === "missing old target" ? nextWorkspace : workspace;
				expect(readFileSync(join(retained, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
					"# Keep old target\n",
				);
			}
			expect(rosterCalls()).toBe(2);
		} finally {
			mutation.mockRestore();
		}
	},
);

test("resolves Skills from the official agent workspace roster", async () => {
	const roster = installRosterCommand();
	writeFileSync(
		roster,
		JSON.stringify([
			{ id: "main", workspace: join(root, "main-workspace") },
			{ id: "sales", workspace: join(root, "sales-workspace") },
		]),
	);

	expect(listOpenClawAgentWorkspaces()).toHaveLength(2);
	expect(resolveOpenClawAgentWorkspace()).toBe(join(root, "main-workspace"));
	expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(join(root, "main-workspace"));
	process.env.OPENCLAW_AGENT_ID = " sales ";
	expect(resolveOpenClawAgentWorkspace()).toBe(join(root, "sales-workspace"));
	expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(join(root, "sales-workspace"));
	expect(await resolveOpenClawAgentWorkspaceAsync("main")).toBe(join(root, "main-workspace"));
	const missingAgent = "OpenClaw agent missing is not present in the official agent roster";
	expect(() => resolveOpenClawAgentWorkspace("missing")).toThrow(missingAgent);
	await expect(resolveOpenClawAgentWorkspaceAsync("missing")).rejects.toMatchObject({
		message: missingAgent,
	});
});

test("resolves and collects Skills as the runtime user without tenant bins in PATH", async () => {
	const roster = installRosterCommand();
	const tenantBin = join(root, ".local", "bin");
	mkdirSync(tenantBin, { recursive: true });
	renameSync(join(root, "bin", "openclaw"), join(tenantBin, "openclaw"));
	const workspace = join(root, "official-workspace");
	const skillDir = join(workspace, "skills", "demo");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "# Demo\n");
	writeFileSync(roster, JSON.stringify([{ id: "main", workspace }]));
	process.env.HOME = root;
	process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
	process.env.CLAWDI_RUNTIME_USER = "fixture-agent";
	process.env.CLAWDI_RUNTIME_UID = String(process.getuid?.());
	process.env.CLAWDI_RUNTIME_GID = String(process.getgid?.());
	delete process.env.OPENCLAW_AGENT_ID;

	expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(workspace);
	const adapter = new OpenClawAdapter();
	expect(await adapter.skills.listKeys()).toEqual(["demo"]);
	expect((await adapter.skills.collect()).map((skill) => skill.filePath)).toEqual([
		join(skillDir, "SKILL.md"),
	]);

	rmSync(join(tenantBin, "openclaw"));
	const message = "OpenClaw workspace resolution requires `openclaw agents list --json`";
	await expect(adapter.skills.listKeys()).rejects.toThrow(message);
	await expect(adapter.skills.collect()).rejects.toThrow(message);
});

test.each([
	{ name: "malformed JSON", output: "not JSON", status: 0 },
	{ name: "empty roster", output: "[]", status: 0 },
	{
		name: "relative workspace",
		output: '[{"id":"main","workspace":"relative"}]',
		status: 0,
	},
	{ name: "nonzero exit", output: "fixture-sensitive-output", status: 1 },
])("rejects $name through both workspace resolvers", async ({ output, status }) => {
	const roster = installRosterCommand(status);
	writeFileSync(roster, output);
	const message = "OpenClaw workspace resolution requires `openclaw agents list --json`";
	expect(() => resolveOpenClawAgentWorkspace()).toThrow(message);
	await expect(resolveOpenClawAgentWorkspaceAsync()).rejects.toMatchObject({ message });
});

test("cancels an unresponsive roster read and joins its process before another command", async () => {
	const roster = installRosterCommand();
	const pidFile = join(root, "pid");
	const command = join(root, "bin", "openclaw");
	writeFileSync(
		command,
		`#!/bin/sh
trap '' TERM
echo $$ > "${pidFile}"
while :; do :; done
`,
	);
	const abort = new AbortController();
	const running = resolveOpenClawAgentWorkspaceAsync("main", abort.signal);
	const result = running.then(
		() => null,
		(error) => error,
	);
	try {
		for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await delay(10);
		expect(existsSync(pidFile)).toBe(true);
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		abort.abort();
		expect(await result).toBeInstanceOf(Error);
		expect(() => process.kill(pid, 0)).toThrow();
		writeFileSync(
			command,
			`#!/bin/sh
cat "${roster}"
`,
		);
		writeFileSync(roster, JSON.stringify([{ id: "main", workspace: root }]));
		expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(root);
	} finally {
		abort.abort();
		await result;
	}
});
