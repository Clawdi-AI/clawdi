import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deployedRevision, deploymentLag, main } from "../../../scripts/clawdi-deployment-lag";
import type { RevisionSnapshot } from "../../../scripts/whatsapp-sidecar-deployment-revision";

const repoRoot = resolve(import.meta.dir, "../../..");
const runsPath = "actions/workflows/clawdi-image-release.yml/runs?per_page=100&page=1";
const deployedSha = "a".repeat(40);
const pendingSha = "b".repeat(40);

function command(repository: string, args: string[], env = process.env): string {
	const result = spawnSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
		{ cwd: repository, encoding: "utf8", env },
	);
	if (result.status !== 0 || result.error) throw new Error("Fixture git command failed");
	return result.stdout.trim();
}

function commit(repository: string, path: string, text: string, timestamp: number): string {
	const file = join(repository, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	command(repository, ["add", "--", path]);
	command(repository, ["commit", "-qm", path], {
		...process.env,
		GIT_AUTHOR_DATE: `@${timestamp} +0000`,
		GIT_COMMITTER_DATE: `@${timestamp} +0000`,
	});
	return command(repository, ["rev-parse", "HEAD"]);
}

function withRepository(check: (repository: string) => void): void {
	const repository = mkdtempSync(join(repoRoot, ".deployment-lag-test-"));
	const previousDirectory = process.cwd();
	try {
		command(repository, ["init", "-q", "--initial-branch=main"]);
		command(repository, ["config", "user.email", "test@example.test"]);
		command(repository, ["config", "user.name", "Test"]);
		process.chdir(repository);
		check(repository);
	} finally {
		process.chdir(previousDirectory);
		rmSync(repository, { recursive: true, force: true });
	}
}

function revisions(snapshot: RevisionSnapshot) {
	const hash = createHash("sha256");
	for (const path of snapshot.listFiles("backend")) {
		if (path.startsWith("backend/tests/")) continue;
		hash.update(path);
		hash.update(snapshot.readText(path));
	}
	return { backend: hash.digest("hex"), deployment: "unchanged", sidecar: "unchanged" };
}

function successfulRun(id: number, event = "workflow_run") {
	return { id, event, status: "completed", conclusion: "success", head_sha: pendingSha };
}

function deployJob(sha = deployedSha, completedAt = "2026-10-09T10:00:00Z") {
	return { name: `deploy-vps ${sha}`, conclusion: "success", completed_at: completedAt };
}

function githubFixture(responses: Record<string, unknown>, calls: string[] = []) {
	return async (path: string): Promise<unknown> => {
		calls.push(path);
		if (!Object.hasOwn(responses, path)) throw new Error(`Unexpected GitHub request: ${path}`);
		return responses[path];
	};
}

function deployedGithub() {
	return githubFixture({
		[runsPath]: { workflow_runs: [successfulRun(1)] },
		"actions/runs/1/jobs?filter=latest&per_page=100": { jobs: [deployJob()] },
	});
}

describe("Cloud deployment lag", () => {
	test("uses the oldest undeployed input and ignores docs at the one-hour boundary", () => {
		withRepository((repository) => {
			const baseline = commit(repository, "backend/app.py", "initial", 10000);
			commit(repository, "docs/status.md", "docs", 11000);
			expect(deploymentLag(baseline, { now: 15000, revisions })).toEqual({
				commit: null,
				ageSeconds: 0,
			});
			const changed = commit(repository, "backend/app.py", "updated", 12000);
			commit(repository, "docs/status.md", "more docs", 14000);
			expect(deploymentLag(baseline, { now: 15601, revisions })).toEqual({
				commit: changed,
				ageSeconds: 3601,
			});
			expect(deploymentLag(baseline, { now: 15600, revisions })).toEqual({
				commit: changed,
				ageSeconds: 3600,
			});
		});
	});

	test("prefilters docs and ignored tests but detects new files under recorded roots", () => {
		withRepository((repository) => {
			const baseline = commit(repository, "backend/app.py", "initial", 10000);
			commit(repository, "docs/status.md", "docs", 11000);
			commit(repository, "backend/tests/test_app.py", "test only", 11500);
			const changed = commit(repository, "backend/new.py", "new input", 12000);
			let calculated = 0;
			expect(
				deploymentLag(baseline, {
					now: 15601,
					revisions: (snapshot) => {
						calculated++;
						return revisions(snapshot);
					},
				}),
			).toEqual({ commit: changed, ageSeconds: 3601 });
			// Baseline, HEAD, ignored backend tests, then the first real input change.
			expect(calculated).toBe(4);
		});
	});

	test("has no lag when input changes have been reverted and clamps future commit times", () => {
		withRepository((repository) => {
			const baseline = commit(repository, "backend/app.py", "initial", 10000);
			const changed = commit(repository, "backend/app.py", "updated", 12000);
			expect(deploymentLag(baseline, { now: 11000, revisions })).toEqual({
				commit: changed,
				ageSeconds: 0,
			});
			commit(repository, "backend/app.py", "initial", 14000);
			expect(deploymentLag(baseline, { now: 20000, revisions })).toEqual({
				commit: null,
				ageSeconds: 0,
			});
		});
	});

	test("rejects deployment evidence outside HEAD ancestry", () => {
		withRepository((repository) => {
			const baseline = commit(repository, "backend/app.py", "initial", 10000);
			command(repository, ["checkout", "-qb", "other"]);
			const other = commit(repository, "backend/app.py", "other", 12000);
			command(repository, ["checkout", "-q", "main"]);
			expect(() => deploymentLag(other, { now: 20000, revisions })).toThrow(
				"Deployment revision could not be compared with main",
			);
			expect(deploymentLag(baseline, { now: 20000, revisions })).toEqual({
				commit: null,
				ageSeconds: 0,
			});
		});
	});

	test("schedule and release share one input and deployed-revision authority", () => {
		const source = readFileSync(join(repoRoot, "scripts/clawdi-deployment-lag.ts"), "utf8");
		expect(source).toContain("classifyClawdiImageRelease,");
		expect(source).toContain("gitSnapshot,");
		expect(source).toContain('from "./clawdi-image-release-plan"');
		const workflow = readFileSync(
			join(repoRoot, ".github/workflows/clawdi-image-release.yml"),
			"utf8",
		);
		expect(workflow).toContain(`name: deploy-vps \${{ needs.build.outputs.image_tag }}`);
		expect(workflow).toContain('job.name.startsWith("deploy-vps ")');
	});

	test("manual legacy release never substitutes head_sha and an older named deploy is used", async () => {
		const github = githubFixture({
			[runsPath]: { workflow_runs: [successfulRun(2, "workflow_dispatch"), successfulRun(1)] },
			"actions/runs/2/jobs?filter=latest&per_page=100": {
				jobs: [{ name: "deploy-vps", conclusion: "success" }],
			},
			"actions/runs/1/jobs?filter=latest&per_page=100": { jobs: [deployJob()] },
		});
		expect(await deployedRevision(github)).toBe(deployedSha);
	});

	test("fails when only a manual legacy job exists", async () => {
		const github = githubFixture({
			[runsPath]: { workflow_runs: [successfulRun(1, "workflow_dispatch")] },
			"actions/runs/1/jobs?filter=latest&per_page=100": {
				jobs: [{ name: "deploy-vps", conclusion: "success" }],
			},
		});
		await expect(deployedRevision(github)).rejects.toThrow(
			"No successful Cloud deployment baseline",
		);
	});

	test("accepts exact named manual authority and legacy automatic authority", async () => {
		for (const event of ["workflow_dispatch", "workflow_run"]) {
			const job =
				event === "workflow_dispatch" ? deployJob() : { ...deployJob(), name: "deploy-vps" };
			const github = githubFixture({
				[runsPath]: {
					workflow_runs: [
						{
							...successfulRun(1, event),
							head_sha: event === "workflow_dispatch" ? pendingSha : deployedSha,
						},
					],
				},
				"actions/runs/1/jobs?filter=latest&per_page=100": { jobs: [job] },
			});
			expect(await deployedRevision(github)).toBe(deployedSha);
		}
	});

	test("skips failed and in-progress runs without requesting a server-side status filter", async () => {
		const calls: string[] = [];
		const github = githubFixture(
			{
				[runsPath]: {
					workflow_runs: [
						{ id: 4, status: "completed", conclusion: "failure" },
						{ id: 3, status: "in_progress", conclusion: null },
						successfulRun(2),
						successfulRun(1),
					],
				},
				"actions/runs/2/jobs?filter=latest&per_page=100": { jobs: [deployJob()] },
				"actions/runs/1/jobs?filter=latest&per_page=100": {
					jobs: [deployJob(pendingSha, "2026-10-09T09:00:00Z")],
				},
			},
			calls,
		);
		expect(await deployedRevision(github)).toBe(deployedSha);
		expect(calls).toEqual([
			runsPath,
			"actions/runs/2/jobs?filter=latest&per_page=100",
			"actions/runs/1/jobs?filter=latest&per_page=100",
		]);
		expect(calls.every((path) => !path.includes("status="))).toBe(true);
	});

	test("uses deployment completion order rather than run order", async () => {
		const github = githubFixture({
			[runsPath]: { workflow_runs: [successfulRun(2), successfulRun(1)] },
			"actions/runs/2/jobs?filter=latest&per_page=100": {
				jobs: [deployJob(pendingSha, "2026-10-09T09:00:00Z")],
			},
			"actions/runs/1/jobs?filter=latest&per_page=100": { jobs: [deployJob()] },
		});
		expect(await deployedRevision(github)).toBe(deployedSha);
	});

	test("fails on multiple deploy jobs even when one was skipped", async () => {
		const github = githubFixture({
			[runsPath]: { workflow_runs: [successfulRun(1)] },
			"actions/runs/1/jobs?filter=latest&per_page=100": {
				jobs: [deployJob(), { ...deployJob(pendingSha), conclusion: "skipped" }],
			},
		});
		await expect(deployedRevision(github)).rejects.toThrow("ambiguous deploy-vps history");
	});

	test("fails on tied deployment completion times", async () => {
		const github = githubFixture({
			[runsPath]: { workflow_runs: [successfulRun(2), successfulRun(1)] },
			"actions/runs/2/jobs?filter=latest&per_page=100": { jobs: [deployJob(pendingSha)] },
			"actions/runs/1/jobs?filter=latest&per_page=100": { jobs: [deployJob()] },
		});
		await expect(deployedRevision(github)).rejects.toThrow(
			"Latest successful deploy-vps authority is ambiguous",
		);
	});

	test("rejects malformed named authority and missing or invalid completion evidence", async () => {
		for (const job of [
			{ ...deployJob(), name: "deploy-vps main" },
			{ ...deployJob(), completed_at: null },
			{ ...deployJob(), completed_at: "invalid" },
		]) {
			const github = githubFixture({
				[runsPath]: { workflow_runs: [successfulRun(1)] },
				"actions/runs/1/jobs?filter=latest&per_page=100": { jobs: [job] },
			});
			await expect(deployedRevision(github)).rejects.toThrow("invalid");
		}
	});

	test("paginates past runs without deployments and stops after five pages", async () => {
		const calls: string[] = [];
		const fullPage = Array.from({ length: 100 }, (_, id) => ({
			id: id + 1,
			status: "completed",
			conclusion: "failure",
		}));
		const github = async (path: string) => {
			calls.push(path);
			return { workflow_runs: fullPage };
		};
		await expect(deployedRevision(github)).rejects.toThrow(
			"No successful Cloud deployment baseline",
		);
		expect(calls).toHaveLength(5);
		expect(calls[4]).toBe(runsPath.replace("&page=1", "&page=5"));
		const nextPage = githubFixture({
			[runsPath]: { workflow_runs: fullPage },
			[runsPath.replace("&page=1", "&page=2")]: { workflow_runs: [successfulRun(1)] },
			"actions/runs/1/jobs?filter=latest&per_page=100": { jobs: [deployJob()] },
		});
		expect(await deployedRevision(nextPage)).toBe(deployedSha);
	});

	test.each([
		[3600, 0],
		[3601, 1],
	])("main fails visibly only beyond one hour (age %i)", async (ageSeconds, expected) => {
		const output = spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(
				await main({
					github: deployedGithub(),
					lag: () => ({ commit: pendingSha, ageSeconds }),
				}),
			).toBe(expected);
			expect(output.mock.calls[0]?.[0]).toContain(
				expected === 1 ? "::error::Cloud backend inputs" : "Cloud deployment lag within budget",
			);
		} finally {
			output.mockRestore();
		}
	});

	test("main fails safely without exposing API errors", async () => {
		const output = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(
				await main({
					github: async () => {
						throw new Error("Private API error with token");
					},
				}),
			).toBe(1);
			expect(output.mock.calls).toEqual([
				["::error::Cloud deployment lag check failed: Release evidence could not be checked"],
			]);
		} finally {
			output.mockRestore();
		}
	});
});
