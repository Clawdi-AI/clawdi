#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	calculateWhatsAppSidecarDeploymentRevisionFromSnapshot,
	type RevisionSnapshot,
} from "./whatsapp-sidecar-deployment-revision";

const BACKEND_ROOT = "backend";
const IMAGE_RELEASE_WORKFLOW = ".github/workflows/clawdi-image-release.yml";
const DEPLOYMENT_FILE_INPUTS = [
	".github/actions/setup-bun-ci/action.yml",
	"config/deploy.yml",
	"scripts/deploy-whatsapp-sidecar.sh",
] as const;

export interface ClawdiImageRevisions {
	backend: string;
	deployment: string;
	sidecar: string;
}

export interface ClawdiImageReleasePlan {
	base: ClawdiImageRevisions;
	baseSha: string;
	changed: { backend: boolean; deployment: boolean; sidecar: boolean };
	head: ClawdiImageRevisions;
	headSha: string;
	releaseRequired: boolean;
}

export function calculateClawdiImageRevisions(
	repositoryRoot: string,
	overrides: ReadonlyMap<string, string> = new Map(),
): ClawdiImageRevisions {
	return calculateClawdiImageRevisionsFromSnapshot({
		listFiles: (root) => filesystemFiles(repositoryRoot, root),
		readText: (path) => overrides.get(path) ?? readFileSync(join(repositoryRoot, path), "utf8"),
	});
}

export function calculateClawdiImageRevisionsFromSnapshot(
	snapshot: RevisionSnapshot,
): ClawdiImageRevisions {
	const dockerignore = snapshot.readText(".dockerignore");
	assertBackendDockerInputContract(snapshot.readText("backend/Dockerfile"), dockerignore);
	const backendInputs = new Map<string, string>([[".dockerignore", dockerignore]]);
	for (const path of snapshot.listFiles(BACKEND_ROOT)) {
		if (path.startsWith("backend/tests/")) continue;
		backendInputs.set(path, snapshot.readText(path));
	}
	const deploymentInputs = new Map<string, string>([
		[
			`${IMAGE_RELEASE_WORKFLOW}#jobs.deploy-vps.steps`,
			extractDeployVpsExecutionContract(snapshot.readText(IMAGE_RELEASE_WORKFLOW)),
		],
	]);
	for (const path of DEPLOYMENT_FILE_INPUTS) {
		deploymentInputs.set(path, snapshot.readText(path));
	}
	return {
		backend: hashInputs(backendInputs),
		deployment: hashInputs(deploymentInputs),
		sidecar: calculateWhatsAppSidecarDeploymentRevisionFromSnapshot(snapshot),
	};
}

function assertBackendDockerInputContract(dockerfile: string, dockerignore: string): void {
	const copyInstructions = dockerfile
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("COPY "));
	const expectedCopies = [
		"COPY backend/pyproject.toml backend/uv.lock backend/alembic.ini ./",
		"COPY --chown=app:app backend/ /app/backend/",
	];
	if (stableStringify(copyInstructions) !== stableStringify(expectedCopies)) {
		throw new Error("backend Docker COPY contract changed; update the image revision inputs");
	}
	const ignoreRules = new Set(
		dockerignore
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean),
	);
	for (const rule of ["backend/.venv", "backend/data", "backend/tests"]) {
		if (!ignoreRules.has(rule)) {
			throw new Error(`backend Docker ignore contract is missing ${rule}`);
		}
	}
}

function extractDeployVpsExecutionContract(workflowSource: string): string {
	// The durable deployment authority covers the executable deploy job and the
	// repository files it invokes. Release gating/authority orchestration stays
	// outside this contract, so changing the classifier cannot trigger itself.
	const workflow = Bun.YAML.parse(workflowSource) as {
		jobs?: {
			"deploy-vps"?: {
				steps?: Array<{
					env?: Record<string, unknown>;
					run?: string;
					uses?: string;
					with?: Record<string, unknown>;
				}>;
			};
		};
	};
	const steps = workflow.jobs?.["deploy-vps"]?.steps;
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error("image release workflow must define deploy-vps execution steps");
	}
	return stableStringify(
		steps.map(({ env, run, uses, with: inputs }) => ({
			...(uses === undefined ? {} : { uses }),
			...(inputs === undefined ? {} : { with: inputs }),
			...(env === undefined ? {} : { env }),
			...(run === undefined ? {} : { run }),
		})),
	);
}

export function classifyClawdiImageRelease(input: {
	base: ClawdiImageRevisions;
	baseSha: string;
	head: ClawdiImageRevisions;
	headSha: string;
}): ClawdiImageReleasePlan {
	const changed = {
		backend: input.base.backend !== input.head.backend,
		deployment: input.base.deployment !== input.head.deployment,
		sidecar: input.base.sidecar !== input.head.sidecar,
	};
	return { ...input, changed, releaseRequired: Object.values(changed).some(Boolean) };
}

function gitSnapshot(repositoryRoot: string, revision: string): RevisionSnapshot {
	if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`invalid Git revision: ${revision}`);
	return {
		listFiles: (root) =>
			git(repositoryRoot, ["ls-tree", "-r", "--name-only", revision, "--", root])
				.split("\n")
				.filter(Boolean)
				.sort(),
		readText: (path) => git(repositoryRoot, ["show", `${revision}:${path}`]),
	};
}

function git(repositoryRoot: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
	if (result.status !== 0 || result.error) {
		throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.error?.message}`);
	}
	return result.stdout;
}

function filesystemFiles(repositoryRoot: string, root: string): string[] {
	const absoluteRoot = join(repositoryRoot, root);
	return readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(repositoryRoot, join(entry.parentPath, entry.name)))
		.sort();
}

function hashInputs(inputs: ReadonlyMap<string, string>): string {
	const hash = createHash("sha256");
	for (const [name, value] of [...inputs].sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(`${Buffer.byteLength(name)}:${name}:${Buffer.byteLength(value)}:`);
		hash.update(value);
	}
	return hash.digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("deployment contract is not serializable");
		return serialized;
	}
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	return `{${Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
		.join(",")}}`;
}

if (import.meta.main) {
	const [baseSha, headSha] = process.argv.slice(2);
	if (!baseSha || !headSha) {
		throw new Error("usage: clawdi-image-release-plan.ts <base-sha> <head-sha>");
	}
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	const repositoryRoot = resolve(scriptDirectory, "..");
	console.log(
		JSON.stringify(
			classifyClawdiImageRelease({
				base: calculateClawdiImageRevisionsFromSnapshot(gitSnapshot(repositoryRoot, baseSha)),
				baseSha,
				head: calculateClawdiImageRevisionsFromSnapshot(gitSnapshot(repositoryRoot, headSha)),
				headSha,
			}),
		),
	);
}
