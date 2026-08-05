import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../adapters/codex";
import { ApiClient } from "../lib/api-client";
import {
	readProjectSkillMaterialization,
	recordProjectSkillMaterialization,
} from "../lib/skills-lock";
import { computeSkillArchiveHash, tarSingleFile } from "../lib/tar";
import { reconcileConnectedProjectSkills } from "./project-skill-reconcile";

const agentId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const apiOrigin = "https://cloud.example.test";

type Desired = {
	project_id: string;
	skill_id: string;
	skill_key: string;
	content_hash: string;
	archive_url: string;
};

describe("Connected Project Skill reconcile", () => {
	let root: string;
	let originalHome: string | undefined;
	let originalClawdiHome: string | undefined;
	let originalCodexHome: string | undefined;
	let originalApiUrl: string | undefined;
	let originalFetch: typeof fetch;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clawdi-project-reconcile-test-"));
		originalHome = process.env.HOME;
		originalClawdiHome = process.env.CLAWDI_HOME;
		originalCodexHome = process.env.CODEX_HOME;
		originalApiUrl = process.env.CLAWDI_API_URL;
		originalFetch = globalThis.fetch;
		process.env.HOME = root;
		process.env.CLAWDI_HOME = join(root, ".clawdi");
		process.env.CODEX_HOME = join(root, ".codex");
		process.env.CLAWDI_API_URL = apiOrigin;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
		else process.env.CLAWDI_HOME = originalClawdiHome;
		if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = originalCodexHome;
		if (originalApiUrl === undefined) delete process.env.CLAWDI_API_URL;
		else process.env.CLAWDI_API_URL = originalApiUrl;
		rmSync(root, { recursive: true, force: true });
	});

	async function desiredSkill(
		skillKey: string,
		marker: string,
	): Promise<{
		desired: Desired;
		archive: Buffer;
	}> {
		const archive = await tarSingleFile(
			skillKey,
			`---\nname: ${skillKey}\ndescription: Project Skill\n---\n\n# ${marker}\n`,
		);
		const contentHash = await computeSkillArchiveHash(archive, skillKey);
		const digit = skillKey === "alpha" ? "3" : "4";
		const skillId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
		return {
			archive,
			desired: {
				project_id: projectId,
				skill_id: skillId,
				skill_key: skillKey,
				content_hash: contentHash,
				archive_url: `${apiOrigin}/v1/runtime/project-skill-archives/${agentId}/${projectId}/${skillId}/${contentHash}/signature/${skillKey}.tar.gz`,
			},
		};
	}

	function serveInventory(skills: Array<{ desired: Desired; archive: Buffer }>): {
		archiveRequests: string[];
		capabilityReports: string[];
	} {
		const archiveRequests: string[] = [];
		const capabilityReports: string[] = [];
		const byHash = new Map(skills.map(({ desired, archive }) => [desired.content_hash, archive]));
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : new Request(input, init);
			const url = new URL(request.url);
			if (url.pathname === "/v1/runtime/project-skill-capability") {
				capabilityReports.push(await request.text());
				return new Response(null, { status: 204 });
			}
			if (url.pathname === "/v1/runtime/project-skills") {
				return new Response(
					JSON.stringify({ agent_id: agentId, skills: skills.map(({ desired }) => desired) }),
					{ headers: { "content-type": "application/json" } },
				);
			}
			archiveRequests.push(url.pathname);
			const contentHash = [...byHash.keys()].find((hash) => url.pathname.includes(`/${hash}/`));
			const archive = contentHash ? byHash.get(contentHash) : undefined;
			return archive
				? new Response(Uint8Array.from(archive), {
						headers: { "content-type": "application/gzip" },
					})
				: new Response("missing", { status: 404 });
		}) as typeof fetch;
		return { archiveRequests, capabilityReports };
	}

	it("installs the complete desired inventory through the existing adapter and records ownership", async () => {
		const alpha = await desiredSkill("alpha", "Alpha");
		const { archiveRequests, capabilityReports } = serveInventory([alpha]);
		const adapter = new CodexAdapter();

		await reconcileConnectedProjectSkills({
			api: new ApiClient({ requireAuth: false }),
			agentId,
			adapter,
		});

		expect(readFileSync(adapter.getSkillPath("alpha"), "utf8")).toContain("# Alpha");
		expect(archiveRequests).toHaveLength(1);
		expect(capabilityReports.map((body) => JSON.parse(body))).toEqual([
			{ project_skill_reconcile_version: 1 },
		]);
		expect(readProjectSkillMaterialization({ agentType: "codex", localSkillKey: "alpha" })).toEqual(
			{
				agent_type: "codex",
				local_skill_key: "alpha",
				source_project_id: projectId,
				source_skill_key: "alpha",
				content_hash: alpha.desired.content_hash,
				reconcile_agent_id: agentId,
			},
		);
	});

	it("fails closed on an unowned local collision without downloading or overwriting", async () => {
		const alpha = await desiredSkill("alpha", "Cloud");
		const { archiveRequests } = serveInventory([alpha]);
		const adapter = new CodexAdapter();
		mkdirSync(join(process.env.CODEX_HOME ?? "", "skills", "alpha"), { recursive: true });
		writeFileSync(adapter.getSkillPath("alpha"), "# Local Workspace Skill\n");

		await expect(
			reconcileConnectedProjectSkills({
				api: new ApiClient({ requireAuth: false }),
				agentId,
				adapter,
			}),
		).rejects.toThrow("already exists in this Agent's Workspace");
		expect(readFileSync(adapter.getSkillPath("alpha"), "utf8")).toBe("# Local Workspace Skill\n");
		expect(archiveRequests).toHaveLength(0);
	});

	it("removes only exact daemon-owned materializations", async () => {
		const alpha = await desiredSkill("alpha", "Alpha");
		serveInventory([alpha]);
		const adapter = new CodexAdapter();
		await reconcileConnectedProjectSkills({
			api: new ApiClient({ requireAuth: false }),
			agentId,
			adapter,
		});

		const explicit = await desiredSkill("explicit", "Explicit");
		await adapter.writeSkillArchive("explicit", explicit.archive);
		recordProjectSkillMaterialization({
			agentType: "codex",
			localSkillKey: "explicit",
			sourceProjectId: projectId,
			sourceSkillKey: "explicit",
			contentHash: explicit.desired.content_hash,
		});
		serveInventory([]);
		await reconcileConnectedProjectSkills({
			api: new ApiClient({ requireAuth: false }),
			agentId,
			adapter,
		});

		expect(existsSync(adapter.getSkillPath("alpha"))).toBe(false);
		expect(
			readProjectSkillMaterialization({ agentType: "codex", localSkillKey: "alpha" }),
		).toBeNull();
		expect(readFileSync(adapter.getSkillPath("explicit"), "utf8")).toContain("# Explicit");
		expect(
			readProjectSkillMaterialization({ agentType: "codex", localSkillKey: "explicit" }),
		).not.toBeNull();
	});

	it("rolls back earlier installs when a later native install fails", async () => {
		const alpha = await desiredSkill("alpha", "Alpha");
		const beta = await desiredSkill("beta", "Beta");
		serveInventory([alpha, beta]);
		const adapter = new CodexAdapter();
		const failingAdapter = {
			agentType: adapter.agentType,
			getSkillPath: (key: string) => adapter.getSkillPath(key),
			listSkillKeys: () => adapter.listSkillKeys(),
			removeLocalSkill: (key: string) => adapter.removeLocalSkill(key),
			writeSkillArchive: async (key: string, archive: Buffer) => {
				if (key === "beta") throw new Error("injected native install failure");
				await adapter.writeSkillArchive(key, archive);
			},
		};

		await expect(
			reconcileConnectedProjectSkills({
				api: new ApiClient({ requireAuth: false }),
				agentId,
				adapter: failingAdapter,
			}),
		).rejects.toThrow("injected native install failure");
		expect(existsSync(adapter.getSkillPath("alpha"))).toBe(false);
		expect(existsSync(adapter.getSkillPath("beta"))).toBe(false);
		expect(
			readProjectSkillMaterialization({ agentType: "codex", localSkillKey: "alpha" }),
		).toBeNull();
		expect(
			readProjectSkillMaterialization({ agentType: "codex", localSkillKey: "beta" }),
		).toBeNull();
	});
});
