import { afterEach, describe, expect, test } from "bun:test";
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
import { prepareHostedSourcedSkillArchives } from "./hosted-sourced-skill-archive";
import type { RuntimeManifest } from "./manifest-contract";
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

describe("hosted sourced Skill archives", () => {
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
		const paths = getRuntimePaths({ mode: "hosted" });
		const first = await prepareHostedSourcedSkillArchives(manifest(commit), paths, { fetcher });
		const prepared = first.get("review-pr");
		expect(prepared).toMatchObject({
			skillId: "review-pr",
			source: { commit },
		});
		expect(prepared?.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(requestedUrls).toEqual([`https://codeload.github.com/Clawdi-AI/store/tar.gz/${commit}`]);

		const cached = await prepareHostedSourcedSkillArchives(manifest(commit), paths, {
			fetcher: async () => {
				throw new Error("cache should satisfy the exact source offline");
			},
		});
		expect(cached.get("review-pr")?.archiveSha256).toBe(prepared?.archiveSha256);
		expect(cached.get("review-pr")?.sourceIdentity).toBe(prepared?.sourceIdentity);

		// Cache loss may yield different gzip/tar bytes for the same pinned tree.
		rmSync(join(paths.cacheRoot, "workspace-skills"), { recursive: true });
		utimesSync(
			join(skillDir, "SKILL.md"),
			new Date("2026-01-02T00:00:00Z"),
			new Date("2026-01-02T00:00:00Z"),
		);
		chmodSync(join(skillDir, "reference.md"), 0o755);
		const repackedArchive = await codeloadArchive(root, repositoryRoot, 1);
		const refetched = await prepareHostedSourcedSkillArchives(manifest(commit), paths, {
			fetcher: async () =>
				new Response(Uint8Array.from(repackedArchive), {
					status: 200,
					headers: { "content-length": String(repackedArchive.byteLength) },
				}),
		});
		expect(refetched.get("review-pr")?.archiveSha256).not.toBe(prepared?.archiveSha256);
		expect(refetched.get("review-pr")?.sourceIdentity).toBe(prepared?.sourceIdentity);

		const cacheKeys = readdirSync(join(paths.cacheRoot, "workspace-skills"));
		expect(cacheKeys).toHaveLength(1);
		writeFileSync(
			join(paths.cacheRoot, "workspace-skills", cacheKeys[0] ?? "missing", "skill.tar.gz"),
			"tampered",
		);
		await prepareHostedSourcedSkillArchives(manifest(commit), paths, { fetcher });
		expect(requestedUrls).toHaveLength(2);
	});
});
