import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEffectiveFilesystemIdentity } from "./effective-identity";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import {
	flushPersistedStepRevisions,
	loadPersistedStepRevisions,
	openClawStepIdentity,
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

test("old memos and disabled adoption cannot skip upgrade work", () => {
	const paths = hostedPaths();
	writeFileSync(
		join(paths.statusRoot, "runtime-step-revisions.json"),
		JSON.stringify({
			schemaVersion: "clawdi.runtimeStepRevisions.v1",
			entries: { step: "old" },
		}),
		{ mode: 0o600 },
	);
	loadPersistedStepRevisions(paths);
	expect(persistedStepRevision("step")).toBeUndefined();
	loadPersistedStepRevisions(paths, false);
	recordPersistedStepRevision("step", "new");
	flushPersistedStepRevisions(paths);
	expect(persistedStepRevision("step")).toBeUndefined();
});

test("CLI, helper and package upgrades invalidate a memo with identical launcher bytes", () => {
	const paths = hostedPaths();
	const home = paths.userHome;
	const nativePackage = join(home, ".local/tools/node/lib/node_modules/openclaw/package.json");
	mkdirSync(join(nativePackage, ".."), { recursive: true });
	writeFileSync(nativePackage, JSON.stringify({ name: "openclaw", version: "1.0.0" }));
	const first = openClawStepIdentity(home, ["probe-v1"]);
	expect(openClawStepIdentity(home, ["probe-v2"])).not.toBe(first);
	writeFileSync(nativePackage, JSON.stringify({ name: "openclaw", version: "2.0.0" }));
	expect(openClawStepIdentity(home, ["probe-v1"])).not.toBe(first);
	const cliPackage = join(import.meta.dir, "../../package.json");
	const original = readFileSync(cliPackage, "utf8");
	const before = openClawStepIdentity(home, ["probe-v1"]);
	try {
		writeFileSync(cliPackage, JSON.stringify({ ...JSON.parse(original), version: "upgrade-test" }));
		const upgraded = spawnSync(
			process.execPath,
			[
				"--eval",
				`import { openClawStepIdentity } from ${JSON.stringify(join(import.meta.dir, "persisted-step-revisions.ts"))}; console.log(openClawStepIdentity(${JSON.stringify(home)}, ["probe-v1"]));`,
			],
			{ encoding: "utf8" },
		);
		expect(upgraded.status).toBe(0);
		expect(upgraded.stdout.trim()).not.toBe(before);
	} finally {
		writeFileSync(cliPackage, original);
	}
});

test.skipIf(process.geteuid?.() !== 0)(
	"CLI memo identity survives a runtime UID without CLI package access",
	() => {
		const paths = hostedPaths();
		const cliPackage = join(import.meta.dir, "../../package.json");
		const mode = statSync(cliPackage).mode & 0o777;
		const before = openClawStepIdentity(paths.userHome, ["probe"]);
		try {
			chmodSync(cliPackage, 0o600);
			withEffectiveFilesystemIdentity({ uid: 10001, gid: 10001 }, () => {
				expect(() => readFileSync(cliPackage)).toThrow();
				expect(openClawStepIdentity(paths.userHome, ["probe"])).toBe(before);
			});
		} finally {
			chmodSync(cliPackage, mode);
		}
	},
);

test("legacy OpenClaw package layout upgrades invalidate memos", () => {
	const paths = hostedPaths();
	const nativePackage = join(paths.userHome, ".local/lib/node_modules/openclaw/package.json");
	mkdirSync(join(nativePackage, ".."), { recursive: true });
	writeFileSync(nativePackage, JSON.stringify({ name: "openclaw", version: "1.0.0" }));
	const before = openClawStepIdentity(paths.userHome, ["probe"]);
	writeFileSync(nativePackage, JSON.stringify({ name: "openclaw", version: "2.0.0" }));
	expect(openClawStepIdentity(paths.userHome, ["probe"])).not.toBe(before);
});
