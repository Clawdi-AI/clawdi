import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log, toErrorMessage } from "../serve/log";
import type { RuntimePaths } from "./paths";
import { writeRuntimePlatformFileAtomic } from "./state";

/**
 * Root-owned memo of expensive runtime steps that already succeeded for an exact
 * input revision. Each key's revision must cover every input the step reads,
 * including the content of any file it mutates, so a skip is only taken when
 * repeating the step could not change anything. Tenants cannot write this file.
 */
const STORE_SCHEMA = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeStepRevisions.v1"),
		entries: z.record(z.string(), z.string()),
	})
	.strict();
const MAX_ENTRIES = 256;

let entries: Map<string, string> | null = null;
let dirty = false;

function storePath(paths: RuntimePaths): string {
	return join(paths.statusRoot, "runtime-step-revisions.json");
}

/** Load once per convergence, while running with the platform identity. */
export function loadPersistedStepRevisions(paths: RuntimePaths): void {
	entries = new Map();
	dirty = false;
	if (paths.mode !== "hosted") return;
	const path = storePath(paths);
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return;
		const parsed = STORE_SCHEMA.parse(JSON.parse(readFileSync(path, "utf8")));
		entries = new Map(Object.entries(parsed.entries));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			log.warn("runtime.step_revisions_unreadable", { error: toErrorMessage(error) });
		}
	}
}

export function persistedStepRevision(key: string): string | undefined {
	return entries?.get(key);
}

export function recordPersistedStepRevision(key: string, revision: string): void {
	if (!entries) return;
	entries.delete(key);
	entries.set(key, revision);
	while (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
	dirty = true;
}

/** Persist after a committed convergence, with the platform identity. */
export function flushPersistedStepRevisions(paths: RuntimePaths): void {
	if (!entries || !dirty || paths.mode !== "hosted") return;
	writeRuntimePlatformFileAtomic(
		paths,
		storePath(paths),
		`${JSON.stringify({
			schemaVersion: "clawdi.runtimeStepRevisions.v1",
			entries: Object.fromEntries(entries),
		})}\n`,
		{ mode: 0o600 },
	);
	dirty = false;
}

/** Content identity of files a step reads or writes; absent files are explicit. */
export function runtimeFilesContentRevision(files: readonly string[]): string {
	const digest = createHash("sha256");
	for (const file of files) {
		digest.update(file);
		digest.update("\0");
		try {
			digest.update(createHash("sha256").update(readFileSync(file)).digest("hex"));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			digest.update("absent");
		}
		digest.update("\0");
	}
	return digest.digest("hex");
}

export function resetPersistedStepRevisionsForTest(): void {
	entries = null;
	dirty = false;
}
