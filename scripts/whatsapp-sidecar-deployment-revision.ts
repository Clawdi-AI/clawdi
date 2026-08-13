#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_ROOT = "packages/whatsapp-baileys-sidecar";
const SIDECAR_WORKSPACE = "packages/whatsapp-baileys-sidecar";
const SIDECAR_SOURCE_ROOT = `${SIDECAR_ROOT}/src`;
const TARGET_OS = "linux";
const TARGET_CPU = "x64";

const EXPECTED_DOCKER_CONTEXT_SOURCES = new Set([
	"package.json",
	"bun.lock",
	"patches/libsignal@6.0.0.patch",
	"tsconfig.base.json",
	"apps/web/package.json",
	"packages/cli/package.json",
	"packages/shared/package.json",
	`${SIDECAR_ROOT}/package.json`,
	`${SIDECAR_ROOT}/tsconfig.json`,
	`${SIDECAR_ROOT}/tsconfig.build.json`,
	SIDECAR_SOURCE_ROOT,
]);

const DIRECT_FILE_INPUTS = [
	`${SIDECAR_ROOT}/Dockerfile`,
	"patches/libsignal@6.0.0.patch",
	"tsconfig.base.json",
	`${SIDECAR_ROOT}/package.json`,
	`${SIDECAR_ROOT}/tsconfig.json`,
	`${SIDECAR_ROOT}/tsconfig.build.json`,
] as const;

type TextOverrides = ReadonlyMap<string, string>;

export function calculateWhatsAppSidecarDeploymentRevision(
	repositoryRoot: string,
	overrides: TextOverrides = new Map(),
): string {
	const readText = (path: string): string =>
		overrides.get(path) ?? readFileSync(join(repositoryRoot, path), "utf8");
	const dockerfile = readText(`${SIDECAR_ROOT}/Dockerfile`);
	assertDockerInputContract(dockerfile, readText(".dockerignore"));

	const inputs = new Map<string, string>();
	for (const path of DIRECT_FILE_INPUTS) inputs.set(path, readText(path));
	for (const path of runtimeSourceFiles(repositoryRoot)) inputs.set(path, readText(path));
	inputs.set(
		"bun.lock#whatsapp-sidecar-dependency-closure",
		stableStringify(sidecarDependencyClosure(readText("bun.lock"))),
	);
	inputs.set(
		"config/deploy.yml#accessories.whatsapp-baileys",
		extractWhatsAppSidecarAccessory(readText("config/deploy.yml")),
	);

	const hash = createHash("sha256");
	for (const [name, value] of [...inputs].sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(`${Buffer.byteLength(name)}:${name}:${Buffer.byteLength(value)}:`);
		hash.update(value);
	}
	return hash.digest("hex");
}

export function sidecarDependencyClosure(lockText: string): Record<string, unknown> {
	const parsed = Bun.JSONC.parse(lockText) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.workspaces) || !isRecord(parsed.packages)) {
		throw new Error("bun.lock does not contain the expected workspace package graph");
	}
	const workspace = parsed.workspaces[SIDECAR_WORKSPACE];
	if (!isRecord(workspace)) throw new Error("bun.lock is missing the WhatsApp sidecar workspace");

	const packages = parsed.packages;
	const closure: Record<string, unknown> = {};
	const pending: Array<{ dependency: string; parent?: string }> = [];
	for (const field of ["dependencies", "devDependencies"] as const) {
		const dependencies = workspace[field];
		if (!isRecord(dependencies)) continue;
		for (const dependency of Object.keys(dependencies).sort()) pending.push({ dependency });
	}

	while (pending.length > 0) {
		const request = pending.pop();
		if (!request) break;
		const key = resolvePackageKey(packages, request.dependency, request.parent);
		if (Object.hasOwn(closure, key)) continue;
		const entry = packages[key];
		if (!Array.isArray(entry)) throw new Error(`bun.lock package ${key} has an invalid record`);
		if (!packageMatchesTarget(entry)) continue;
		closure[key] = entry;

		const metadata = entry[2];
		if (!isRecord(metadata)) continue;
		for (const dependency of installDependencies(metadata, packages, key)) {
			pending.push({ dependency, parent: key });
		}
	}

	return closure;
}

function installDependencies(
	metadata: Record<string, unknown>,
	packages: Record<string, unknown>,
	parent: string,
): string[] {
	const result = new Set<string>();
	const required = metadata.dependencies;
	if (isRecord(required)) {
		for (const dependency of Object.keys(required)) result.add(dependency);
	}

	const optional = metadata.optionalDependencies;
	if (isRecord(optional)) {
		for (const dependency of Object.keys(optional)) {
			const key = resolvePackageKey(packages, dependency, parent);
			const entry = packages[key];
			if (Array.isArray(entry) && packageMatchesTarget(entry)) result.add(dependency);
		}
	}

	const optionalPeers = new Set(
		Array.isArray(metadata.optionalPeers)
			? metadata.optionalPeers.filter((value): value is string => typeof value === "string")
			: [],
	);
	const peers = metadata.peerDependencies;
	if (isRecord(peers)) {
		for (const dependency of Object.keys(peers)) {
			if (!optionalPeers.has(dependency) && packageKeyExists(packages, dependency, parent)) {
				result.add(dependency);
			}
		}
	}
	return [...result].sort();
}

function resolvePackageKey(
	packages: Record<string, unknown>,
	dependency: string,
	parent?: string,
): string {
	if (parent) {
		const nested = `${parent}/${dependency}`;
		if (Object.hasOwn(packages, nested)) return nested;
	}
	if (Object.hasOwn(packages, dependency)) return dependency;
	throw new Error(`bun.lock cannot resolve ${dependency}${parent ? ` from ${parent}` : ""}`);
}

function packageKeyExists(
	packages: Record<string, unknown>,
	dependency: string,
	parent: string,
): boolean {
	return Object.hasOwn(packages, `${parent}/${dependency}`) || Object.hasOwn(packages, dependency);
}

function packageMatchesTarget(entry: unknown[]): boolean {
	const metadata = entry[2];
	if (!isRecord(metadata)) return true;
	return platformMatches(metadata.os, TARGET_OS) && platformMatches(metadata.cpu, TARGET_CPU);
}

function platformMatches(constraint: unknown, target: string): boolean {
	if (constraint === undefined) return true;
	const values = typeof constraint === "string" ? [constraint] : constraint;
	if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return false;
	const denied = values.some((value) => value === `!${target}`);
	const allowed = values.filter((value) => !value.startsWith("!"));
	return !denied && (allowed.length === 0 || allowed.includes(target));
}

function runtimeSourceFiles(repositoryRoot: string): string[] {
	const absoluteRoot = join(repositoryRoot, SIDECAR_SOURCE_ROOT);
	return readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.name.endsWith(".test.ts"))
		.map((entry) => relative(repositoryRoot, join(entry.parentPath, entry.name)))
		.sort();
}

function extractWhatsAppSidecarAccessory(source: string): string {
	const startMarker = "\n  whatsapp-baileys:\n";
	const endMarker = "\n  postgres:\n";
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < 0 || source.indexOf(startMarker, start + 1) >= 0) {
		throw new Error("config/deploy.yml must contain one bounded whatsapp-baileys accessory");
	}
	return source.slice(start + 1, end + 1);
}

function assertDockerInputContract(dockerfile: string, dockerignore: string): void {
	const sources = new Set<string>();
	for (const line of dockerfile.split("\n")) {
		const tokens = line.trim().split(/\s+/);
		if (tokens[0] !== "COPY" || tokens.some((token) => token.startsWith("--from="))) continue;
		const positional = tokens.slice(1).filter((token) => !token.startsWith("--"));
		for (const source of positional.slice(0, -1)) sources.add(source);
	}
	if (
		sources.size !== EXPECTED_DOCKER_CONTEXT_SOURCES.size ||
		[...sources].some((source) => !EXPECTED_DOCKER_CONTEXT_SOURCES.has(source))
	) {
		throw new Error("WhatsApp sidecar Docker COPY inputs changed; update the revision contract");
	}
	if (!dockerignore.split("\n").includes(`${SIDECAR_SOURCE_ROOT}/*.test.ts`)) {
		throw new Error("WhatsApp sidecar Docker context must exclude source tests");
	}
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("revision input is not JSON serializable");
		return serialized;
	}
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
		.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
	const scriptDirectory = dirname(fileURLToPath(import.meta.url));
	console.log(calculateWhatsAppSidecarDeploymentRevision(resolve(scriptDirectory, "..")));
}
