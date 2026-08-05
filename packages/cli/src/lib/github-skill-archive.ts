import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { sanitizeSkillKey } from "./skill-key";
import { extractTarGz, tarSkillDir } from "./tar";

const MAX_GITHUB_ARCHIVE_BYTES = 100 * 1024 * 1024;

export interface GithubSkillArchiveSource {
	owner: string;
	repo: string;
	ref?: string;
	path?: string;
}

export type GithubArchiveFetcher = (
	input: URL | RequestInfo,
	init?: RequestInit,
) => Promise<Response>;

export function hasAsciiControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
}

export async function readBoundedResponseBytes(
	response: Response,
	maxBytes: number,
): Promise<Buffer> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new Error("Response byte limit must be a positive safe integer.");
	}
	const declaredHeader = response.headers.get("content-length");
	if (declaredHeader !== null) {
		const declaredBytes = Number(declaredHeader);
		if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
			throw new Error("Response has an invalid Content-Length.");
		}
		if (declaredBytes > maxBytes) {
			await response.body?.cancel("response exceeds byte limit");
			throw new Error("GitHub archive exceeds the 100 MB download limit.");
		}
	}
	if (!response.body) throw new Error("GitHub archive response has no body.");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let receivedBytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			receivedBytes += next.value.byteLength;
			if (receivedBytes > maxBytes) {
				await reader.cancel("response exceeds byte limit");
				throw new Error("GitHub archive exceeds the 100 MB download limit.");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, receivedBytes);
}

export function assertSafeRepositoryPath(path: string): void {
	const segments = path.split("/");
	if (
		path !== path.trim() ||
		segments.length === 0 ||
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				segment.includes("\\") ||
				hasAsciiControlCharacter(segment),
		)
	) {
		throw new Error("GitHub Skill path is invalid.");
	}
}

export function parseCanonicalGithubRepositoryUrl(repoUrl: string): {
	owner: string;
	repo: string;
} {
	let url: URL;
	try {
		url = new URL(repoUrl);
	} catch {
		throw new Error("GitHub repository URL is invalid.");
	}
	const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!match ||
		repoUrl !== `https://github.com${url.pathname}`
	) {
		throw new Error("GitHub repository URL must be canonical.");
	}
	return { owner: match[1], repo: match[2] };
}

export async function fetchGithubSkillArchive(
	source: GithubSkillArchiveSource,
	options: { skillKey?: string; fetcher?: GithubArchiveFetcher } = {},
): Promise<{ skillKey: string; tarBytes: Buffer }> {
	if (source.path) assertSafeRepositoryPath(source.path);
	const archiveUrl = new URL(
		`https://codeload.github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/tar.gz/${encodeURIComponent(source.ref ?? "HEAD")}`,
	);
	const response = await (options.fetcher ?? fetch)(archiveUrl, {
		headers: { Accept: "application/vnd.github+json" },
		redirect: "follow",
	});
	if (!response.ok) {
		throw new Error(`GitHub archive download failed (${response.status}).`);
	}
	const archive = await readBoundedResponseBytes(response, MAX_GITHUB_ARCHIVE_BYTES);

	const extractRoot = mkdtempSync(join(tmpdir(), "clawdi-github-skill-"));
	try {
		await extractTarGz(extractRoot, archive);
		const roots = readdirSync(extractRoot, { withFileTypes: true }).filter((entry) =>
			entry.isDirectory(),
		);
		const rootEntry = roots.length === 1 ? roots[0] : undefined;
		if (!rootEntry) throw new Error("GitHub archive has an unexpected root layout.");
		const repositoryRoot = join(extractRoot, rootEntry.name);
		const sourceDir = source.path ? resolve(repositoryRoot, source.path) : repositoryRoot;
		const fromRepositoryRoot = relative(repositoryRoot, sourceDir);
		if (
			fromRepositoryRoot.startsWith("..") ||
			isAbsolute(fromRepositoryRoot) ||
			!existsSync(join(sourceDir, "SKILL.md"))
		) {
			throw new Error("GitHub source does not contain a Skill at the requested path.");
		}
		const skillKey = sanitizeSkillKey(options.skillKey ?? basename(source.path ?? source.repo));
		const canonicalRoot = mkdtempSync(join(tmpdir(), "clawdi-github-skill-stage-"));
		try {
			const canonicalDir = join(canonicalRoot, skillKey);
			cpSync(sourceDir, canonicalDir, { recursive: true });
			return {
				skillKey,
				tarBytes: await tarSkillDir(canonicalDir, [repositoryRoot, canonicalRoot], skillKey),
			};
		} finally {
			rmSync(canonicalRoot, { recursive: true, force: true });
		}
	} finally {
		rmSync(extractRoot, { recursive: true, force: true });
	}
}
