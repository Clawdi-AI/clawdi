import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import {
	flushPersistedStepRevisions,
	loadPersistedStepRevisions,
	persistedStepRevision,
	recordPersistedStepRevision,
	resetPersistedStepRevisionsForTest,
	runtimeFilesContentRevision,
} from "./persisted-step-revisions";

const roots: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
	process.env = { ...originalEnv };
	resetPersistedStepRevisionsForTest();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hostedPaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-step-revisions-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	const paths = getRuntimePaths({ mode: "hosted" });
	mkdirSync(paths.statusRoot, { recursive: true });
	return paths;
}

test("committed step revisions survive a new process and stay bounded", () => {
	const paths = hostedPaths();
	loadPersistedStepRevisions(paths);
	for (let index = 0; index < 300; index += 1)
		recordPersistedStepRevision(`k${index}`, `r${index}`);
	flushPersistedStepRevisions(paths);
	resetPersistedStepRevisionsForTest();
	loadPersistedStepRevisions(paths);
	expect(persistedStepRevision("k299")).toBe("r299");
	expect(persistedStepRevision("k0")).toBeUndefined();
});

test("an unflushed or untrusted store never authorizes a skip", () => {
	const paths = hostedPaths();
	loadPersistedStepRevisions(paths);
	recordPersistedStepRevision("step", "revision");
	resetPersistedStepRevisionsForTest();
	loadPersistedStepRevisions(paths);
	expect(persistedStepRevision("step")).toBeUndefined();
	const store = join(paths.statusRoot, "runtime-step-revisions.json");
	writeFileSync(
		store,
		JSON.stringify({ schemaVersion: "clawdi.runtimeStepRevisions.v1", entries: { step: "x" } }),
	);
	chmodSync(store, 0o666);
	loadPersistedStepRevisions(paths);
	expect(persistedStepRevision("step")).toBeUndefined();
});

test("file content revisions change with content and presence", () => {
	const paths = hostedPaths();
	const file = join(paths.statusRoot, "config.json");
	const absent = runtimeFilesContentRevision([file]);
	writeFileSync(file, "{}");
	const present = runtimeFilesContentRevision([file]);
	writeFileSync(file, '{"changed":true}');
	expect(new Set([absent, present, runtimeFilesContentRevision([file])]).size).toBe(3);
});
