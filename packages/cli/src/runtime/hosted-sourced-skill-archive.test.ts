import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { computeSkillArchiveHash, snapshotSkillArchive } from "../lib/tar";
import { gcHostedSkillArchives, prepareHostedSkillArchives } from "./hosted-sourced-skill-archive";
import type { RuntimeManifest } from "./manifest-contract";
import { hostedSkillSourceSchema } from "./manifest-resources";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };
let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
	process.env = { ...originalEnv };
});

async function codeloadArchive(
	parent: string,
	repositoryRoot: string,
	gzipLevel = 9,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	const stream = tar.create({ cwd: parent, gzip: { level: gzipLevel } }, [repositoryRoot]);
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function manifest(commit: string): RuntimeManifest {
	const home = join(root, "home");
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_catalog_archive",
		environmentId: "env_catalog_archive",
		instanceId: "hri_catalog_archive",
		generation: 1,
		issuedAt: "2026-08-04T00:00:00.000Z",
		workspaceRoot: join(home, "clawdi"),
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: { hermes: { enabled: true, services: {} } },
		projection: {
			skills: {
				entries: {
					"review-pr": {
						enabled: true,
						source: {
							type: "github",
							url: "https://github.com/Clawdi-AI/store",
							path: "skills/review-pr",
							commit,
						},
					},
				},
			},
		},
		recovery: {},
	};
}

function hostedRuntimePaths() {
	const paths = getRuntimePaths({ mode: "hosted" });
	mkdirSync(paths.cacheRoot, { recursive: true });
	return paths;
}

function projectManifest(
	contentHash: string,
	origin = "https://cloud-api.example.test",
): RuntimeManifest {
	const agentId = "11111111-1111-4111-8111-111111111111";
	const projectId = "22222222-2222-4222-8222-222222222222";
	const skillId = "33333333-3333-4333-8333-333333333333";
	return {
		...manifest("a".repeat(40)),
		environmentId: agentId,
		controlPlane: { apiUrl: origin },
		projection: {
			skills: {
				entries: {
					"review-pr": {
						enabled: true,
						source: {
							type: "project",
							projectId,
							contentHash,
							archiveUrl: `${origin}/v1/runtime/project-skill-archives/${agentId}/${projectId}/${skillId}/${contentHash}/${"f".repeat(64)}/review-pr.tar.gz`,
							installUrl: `${origin}/v1/runtime/project-skill-files/${agentId}/${skillId}/${contentHash}/${"f".repeat(64)}/SKILL.md`,
						},
					},
				},
			},
		},
	};
}

describe("hosted sourced Skill archives", () => {
	test("validates authenticated Project Skill archives and reuses only the exact cache identity", async () => {
		root = mkdtempSync(join(tmpdir(), "project-sourced-skill-"));
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		const skillDir = join(root, "review-pr");
		mkdirSync(join(skillDir, "references"), { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "# Review PR\n\n[Guide](references/guide.md)\n");
		writeFileSync(join(skillDir, "references", "guide.md"), "Pinned guide\n");
		const canonical = await snapshotSkillArchive(skillDir, root, "review-pr");
		const desired = projectManifest(canonical.hash);
		const desiredEntry = desired.projection?.skills?.entries["review-pr"];
		if (!desiredEntry || !("source" in desiredEntry)) throw new Error("missing Project source");
		if (desiredEntry.source.type !== "project") throw new Error("wrong Project source type");
		expect(hostedSkillSourceSchema.parse(desiredEntry.source)).toMatchObject({
			type: "project",
			contentHash: canonical.hash,
		});
		const requests: Array<{
			url: string;
			authorization: string | null;
			redirect?: RequestRedirect;
		}> = [];
		const fetcher = async (input: URL | RequestInfo, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				authorization: headers.get("authorization"),
				redirect: init?.redirect,
			});
			return new Response(Uint8Array.from(canonical.archive), {
				status: 200,
				headers: { "content-length": String(canonical.archive.byteLength) },
			});
		};
		const paths = hostedRuntimePaths();
		const first = await prepareHostedSkillArchives(desired, paths, {
			authToken: "runtime-token",
			fetcher,
		});
		expect(first.get("review-pr")?.identity).toMatchObject({
			sourceIdentity: [
				"project",
				"review-pr",
				"22222222-2222-4222-8222-222222222222",
				canonical.hash,
			].join("\0"),
		});
		expect(requests).toEqual([
			{
				url: desiredEntry.source.archiveUrl,
				authorization: "Bearer runtime-token",
				redirect: "error",
			},
		]);

		const cached = await prepareHostedSkillArchives(desired, paths, {
			fetcher: async () => {
				throw new Error("exact cache should work offline");
			},
		});
		expect(cached.get("review-pr")?.identity.digest).toBe(first.get("review-pr")?.identity.digest);

		const wrongOrigin = projectManifest(canonical.hash, "https://other.example.test");
		wrongOrigin.controlPlane.apiUrl = "https://cloud-api.example.test";
		await expect(prepareHostedSkillArchives(wrongOrigin, paths)).rejects.toThrow(
			"do not match the control plane",
		);
	});

	test("rejects Project Skill size and content identity failures", async () => {
		root = mkdtempSync(join(tmpdir(), "project-sourced-skill-reject-"));
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		const skillDir = join(root, "review-pr");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "# Review PR\n");
		const canonical = await snapshotSkillArchive(skillDir, root, "review-pr");
		const paths = hostedRuntimePaths();

		await expect(
			prepareHostedSkillArchives(projectManifest("0".repeat(64)), paths, {
				authToken: "runtime-token",
				fetcher: async () => new Response(Uint8Array.from(canonical.archive), { status: 200 }),
			}),
		).rejects.toThrow("does not match its content identity");
		await expect(
			prepareHostedSkillArchives(projectManifest(canonical.hash), paths, {
				authToken: "runtime-token",
				fetcher: async () =>
					new Response("too large", {
						status: 200,
						headers: { "content-length": String(25 * 1024 * 1024 + 1) },
					}),
			}),
		).rejects.toThrow("25 MB download limit");
	});

	test("accepts the historical single-file content hash only for a lone SKILL.md", async () => {
		root = mkdtempSync(join(tmpdir(), "project-sourced-legacy-skill-"));
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		const skillDir = join(root, "review-pr");
		mkdirSync(skillDir, { recursive: true });
		const skillMd = Buffer.from("# Historical Review PR\n");
		writeFileSync(join(skillDir, "SKILL.md"), skillMd);
		const canonical = await snapshotSkillArchive(skillDir, root, "review-pr");
		const legacyHash = createHash("sha256").update(skillMd).digest("hex");

		const prepared = await prepareHostedSkillArchives(
			projectManifest(legacyHash),
			hostedRuntimePaths(),
			{
				fetcher: async () => new Response(Uint8Array.from(canonical.archive), { status: 200 }),
			},
		);

		const preparedSkill = prepared.get("review-pr");
		if (!preparedSkill || !("tarBytes" in preparedSkill)) {
			throw new Error("missing prepared legacy Project Skill archive");
		}
		expect(await computeSkillArchiveHash(preparedSkill.tarBytes, "review-pr")).toBe(canonical.hash);
	});

	test("fetches the exact commit and reuses only a digest-verified cache", async () => {
		root = mkdtempSync(join(tmpdir(), "hosted-sourced-skill-"));
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		const commit = "a".repeat(40);
		const repositoryRoot = `store-${commit}`;
		const skillDir = join(root, repositoryRoot, "skills", "review-pr");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "# Review PR\n");
		writeFileSync(join(skillDir, "reference.md"), "source identity\n".repeat(4096));
		const archive = await codeloadArchive(root, repositoryRoot);
		const requestedUrls: string[] = [];
		const fetcher = async (input: URL | RequestInfo) => {
			requestedUrls.push(String(input));
			return new Response(Uint8Array.from(archive), {
				status: 200,
				headers: { "content-length": String(archive.byteLength) },
			});
		};
		const paths = hostedRuntimePaths();
		const first = await prepareHostedSkillArchives(manifest(commit), paths, { fetcher });
		const prepared = first.get("review-pr");
		expect(prepared).toMatchObject({
			id: "review-pr",
			identity: { source: { commit } },
		});
		expect(prepared?.identity.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(requestedUrls).toEqual([`https://codeload.github.com/Clawdi-AI/store/tar.gz/${commit}`]);

		const cached = await prepareHostedSkillArchives(manifest(commit), paths, {
			fetcher: async () => {
				throw new Error("cache should satisfy the exact source offline");
			},
		});
		expect(cached.get("review-pr")?.identity.digest).toBe(prepared?.identity.digest);
		expect(cached.get("review-pr")?.identity).toEqual(prepared?.identity);

		// Cache loss may yield different gzip/tar bytes for the same pinned tree.
		rmSync(join(paths.cacheRoot, "workspace-skills"), { recursive: true });
		utimesSync(
			join(skillDir, "SKILL.md"),
			new Date("2026-01-02T00:00:00Z"),
			new Date("2026-01-02T00:00:00Z"),
		);
		chmodSync(join(skillDir, "reference.md"), 0o755);
		const repackedArchive = await codeloadArchive(root, repositoryRoot, 1);
		const refetched = await prepareHostedSkillArchives(manifest(commit), paths, {
			fetcher: async () =>
				new Response(Uint8Array.from(repackedArchive), {
					status: 200,
					headers: { "content-length": String(repackedArchive.byteLength) },
				}),
		});
		expect(refetched.get("review-pr")?.identity.digest).not.toBe(prepared?.identity.digest);
		expect(refetched.get("review-pr")?.identity.source).toEqual(prepared?.identity.source);

		const cacheKeys = readdirSync(join(paths.cacheRoot, "workspace-skills"));
		expect(cacheKeys).toHaveLength(1);
		writeFileSync(
			join(paths.cacheRoot, "workspace-skills", cacheKeys[0] ?? "missing", "skill.tar.gz"),
			"tampered",
		);
		await prepareHostedSkillArchives(manifest(commit), paths, { fetcher });
		expect(requestedUrls).toHaveLength(2);

		const nextCommit = "b".repeat(40);
		await prepareHostedSkillArchives(manifest(nextCommit), paths, { fetcher });
		expect(readdirSync(join(paths.cacheRoot, "workspace-skills"))).toHaveLength(2);
		gcHostedSkillArchives(manifest(nextCommit), paths);
		expect(readdirSync(join(paths.cacheRoot, "workspace-skills"))).toHaveLength(1);
	});
});
