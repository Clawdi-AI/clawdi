#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	calculateClawdiImageRevisionsFromSnapshot,
	classifyClawdiImageRelease,
	gitSnapshot,
} from "./clawdi-image-release-plan";
import type { RevisionSnapshot } from "./whatsapp-sidecar-deployment-revision";

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_AGE_SECONDS = 3600;
type Github = (path: string) => Promise<unknown>;
type Revisions = typeof calculateClawdiImageRevisionsFromSnapshot;

interface DeploymentLag {
	commit: string | null;
	ageSeconds: number;
}

class CheckError extends Error {}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new CheckError("GitHub release evidence has invalid metadata");
	}
	return value as Record<string, unknown>;
}

function entries(value: unknown, key: string): Record<string, unknown>[] {
	const items = record(value)[key];
	if (!Array.isArray(items)) {
		throw new CheckError("GitHub release evidence has invalid metadata");
	}
	return items.map(record);
}

export async function deployedRevision(github: Github): Promise<string> {
	for (let page = 1; page <= 5; page++) {
		// Filtering status on the server caps the history at 1,000 results and can
		// return a stale baseline. Match completed successful runs locally instead.
		const runs = entries(
			await github(`actions/workflows/clawdi-image-release.yml/runs?per_page=100&page=${page}`),
			"workflow_runs",
		);
		const deployed: { sha: string; completedAt: number }[] = [];
		for (const run of runs) {
			if (run.status !== "completed" || run.conclusion !== "success") continue;
			if (typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id <= 0) {
				throw new CheckError("GitHub release evidence has invalid run metadata");
			}
			const jobs = entries(
				await github(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`),
				"jobs",
			);
			const deployJobs = jobs.filter(
				(job) =>
					job.name === "deploy-vps" ||
					(typeof job.name === "string" && job.name.startsWith("deploy-vps ")),
			);
			if (deployJobs.length > 1) {
				throw new CheckError("Release run has ambiguous deploy-vps history");
			}
			const deploy = deployJobs[0];
			if (deploy?.conclusion !== "success") continue;
			const namedSha = /^deploy-vps ([0-9a-f]{40})$/.exec(String(deploy.name))?.[1];
			if (deploy.name !== "deploy-vps" && !namedSha) {
				throw new CheckError("Release run has invalid named deployment authority");
			}
			const legacyAutomaticSha = run.event === "workflow_run" ? run.head_sha : undefined;
			if (!namedSha && legacyAutomaticSha === undefined) continue;
			const sha = namedSha ?? legacyAutomaticSha;
			const completedAt =
				typeof deploy.completed_at === "string" ? Date.parse(deploy.completed_at) : Number.NaN;
			if (typeof sha !== "string" || !FULL_SHA.test(sha) || !Number.isFinite(completedAt)) {
				throw new CheckError("Release run has invalid deployment authority metadata");
			}
			deployed.push({ sha, completedAt });
		}
		deployed.sort((left, right) => right.completedAt - left.completedAt);
		const latest = deployed[0];
		if (latest) {
			if (latest.completedAt === deployed[1]?.completedAt) {
				throw new CheckError("Latest successful deploy-vps authority is ambiguous");
			}
			return latest.sha;
		}
		if (runs.length < 100) break;
	}
	throw new CheckError("No successful Cloud deployment baseline found");
}

function git(args: string[]): string {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.status !== 0 || result.error) {
		throw new CheckError("Deployment revision could not be compared with main");
	}
	return result.stdout.trim();
}

export function deploymentLag(
	deployedSha: string,
	{
		now,
		revisions = calculateClawdiImageRevisionsFromSnapshot,
	}: { now: number; revisions?: Revisions },
): DeploymentLag {
	if (!FULL_SHA.test(deployedSha) || !Number.isFinite(now)) {
		throw new CheckError("Invalid deployment revision or check time");
	}
	git(["merge-base", "--is-ancestor", deployedSha, "HEAD"]);
	const headSha = git(["rev-parse", "HEAD"]);
	const paths = new Set<string>();
	const roots = new Set<string>();
	function revision(sha: string, recording = false) {
		const snapshot = gitSnapshot(process.cwd(), sha);
		const recorded: RevisionSnapshot = {
			listFiles: (root) => {
				roots.add(root);
				return snapshot.listFiles(root);
			},
			readText: (path) => {
				paths.add(path);
				return snapshot.readText(path);
			},
		};
		try {
			return revisions(recording ? recorded : snapshot);
		} catch {
			throw new CheckError("Image release inputs could not be compared with main");
		}
	}
	const base = revision(deployedSha, true);
	const requiresRelease = (sha: string) =>
		classifyClawdiImageRelease({
			base,
			baseSha: deployedSha,
			head: revision(sha),
			headSha: sha,
		}).releaseRequired;
	if (!requiresRelease(headSha)) return { commit: null, ageSeconds: 0 };
	const commits = git(["rev-list", "--reverse", "--first-parent", `${deployedSha}..HEAD`]);
	for (const commit of commits.split("\n").filter(Boolean)) {
		const files = git(["diff", "--name-only", "-z", `${commit}^`, commit]).split("\0");
		if (
			!files.some(
				(path) => paths.has(path) || [...roots].some((root) => path.startsWith(`${root}/`)),
			)
		) {
			continue;
		}
		if (!requiresRelease(commit)) continue;
		const timestamp = Number(git(["show", "-s", "--format=%ct", commit]));
		if (!Number.isSafeInteger(timestamp)) {
			throw new CheckError("Main commit has an invalid committer time");
		}
		return { commit, ageSeconds: Math.max(0, Math.floor(now) - timestamp) };
	}
	throw new CheckError("Undeployed Cloud inputs have no main commit evidence");
}

async function github(path: string): Promise<unknown> {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone Actions check runs outside Turborepo.
	const token = process.env.GH_TOKEN;
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone Actions check runs outside Turborepo.
	const repository = process.env.GITHUB_REPOSITORY;
	if (!token || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
		throw new CheckError("GitHub release evidence requires GH_TOKEN and GITHUB_REPOSITORY");
	}
	try {
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone Actions check runs outside Turborepo.
		const apiUrl = new URL(process.env.GITHUB_API_URL ?? "https://api.github.com");
		if (apiUrl.protocol !== "https:" || apiUrl.username || apiUrl.password) {
			throw new Error("Invalid API URL");
		}
		const response = await fetch(`${apiUrl.href.replace(/\/$/, "")}/repos/${repository}/${path}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error("GitHub request failed");
		return await response.json();
	} catch {
		throw new CheckError("GitHub release evidence could not be read");
	}
}

export async function main(
	options: { github?: Github; lag?: typeof deploymentLag; now?: number } = {},
): Promise<number> {
	try {
		const deployedSha = await deployedRevision(options.github ?? github);
		const { commit, ageSeconds } = (options.lag ?? deploymentLag)(deployedSha, {
			now: options.now ?? Date.now() / 1000,
		});
		if (commit !== null && ageSeconds > MAX_AGE_SECONDS) {
			console.log(
				`::error::Cloud backend inputs from ${commit} remain undeployed for ${Math.floor(ageSeconds / 60)} minutes (deployed ${deployedSha})`,
			);
			return 1;
		}
		console.log(
			`Cloud deployment lag within budget: ${Math.floor(ageSeconds / 60)} minutes; deployed ${deployedSha}`,
		);
		return 0;
	} catch (error) {
		const detail =
			error instanceof CheckError ? error.message : "Release evidence could not be checked";
		console.error(`::error::Cloud deployment lag check failed: ${detail}`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await main();
