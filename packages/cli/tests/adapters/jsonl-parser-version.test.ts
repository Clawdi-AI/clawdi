import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { type SessionModule, scanSessionModule } from "../../src/adapters/base";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import { CodexAdapter } from "../../src/adapters/codex";
import { PiAdapter } from "../../src/adapters/pi";
import { listJsonlFiles } from "../../src/adapters/session-files";
import { JsonlSessionSource } from "../../src/adapters/session-source";
import { cleanupTmp, copyFixtureToTmp } from "./helpers";

const homeVariables = [
	"HOME",
	"CODEX_HOME",
	"CLAUDE_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
];
let originalEnvironment: Map<string, string | undefined>;
let tmpHome: string;

beforeEach(() => {
	originalEnvironment = new Map(homeVariables.map((name) => [name, process.env[name]]));
	for (const name of homeVariables) delete process.env[name];
	tmpHome = copyFixtureToTmp("codex");
	process.env.HOME = tmpHome;
	cpSync(join(import.meta.dir, "../fixtures/claude-code/.claude"), join(tmpHome, ".claude"), {
		recursive: true,
	});
	const piHome = join(tmpHome, "pi");
	process.env.PI_CODING_AGENT_DIR = piHome;
	mkdirSync(join(piHome, "sessions"), { recursive: true });
	copyFileSync(
		join(import.meta.dir, "../fixtures/pi/session-v3.jsonl"),
		join(piHome, "sessions", "session.jsonl"),
	);
	const past = new Date(Date.now() - 10_000);
	for (const root of [
		join(tmpHome, ".codex", "sessions"),
		join(tmpHome, ".claude", "projects"),
		join(piHome, "sessions"),
	]) {
		for (const file of listJsonlFiles(root)) utimesSync(file, past, past);
	}
});

afterEach(() => {
	for (const [name, value] of originalEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	cleanupTmp(tmpHome);
});

function adapters() {
	return [
		{ version: "codex-v2", previous: "codex-v1", module: new CodexAdapter().sessions },
		{ version: "pi-v1", previous: "pi-v0", module: new PiAdapter().sessions },
		{ version: "claude-v1", previous: "claude-v0", module: new ClaudeCodeAdapter().sessions },
	];
}

async function scan(module: SessionModule, known: ReadonlyMap<string, string> = new Map()) {
	const result = await scanSessionModule(module, { kind: "complete" }, known);
	for await (const batch of result.batches) return batch;
	throw new Error("expected a JSONL scan batch");
}

describe("JSONL adapter parser versions", () => {
	test("preserves the released Codex revision and gives Pi and Claude their own namespace", async () => {
		for (const { version, module } of adapters()) {
			const first = await scan(module);
			expect(first.sessions.length).toBeGreaterThan(0);
			for (const session of first.sessions) {
				const stat = statSync(session.rawFilePath, { bigint: true });
				if (stat.ino === 0n) {
					expect(session.sourceRevision).toBeUndefined();
					continue;
				}
				// Golden for the revision bytes released in CLI 0.16.1 (projection 7).
				expect(session.sourceRevision).toBe(
					`${version}:jsonl-stat-v1:p7:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
				);
			}
		}
	});

	test.each(["codex-v2", "pi-v1", "claude-v1"])(
		"a bump to %s re-parses only that adapter's confirmed sources",
		async (changedVersion) => {
			const confirmed = await Promise.all(
				adapters().map(async (adapter) => {
					const first = await scan(adapter.module);
					const known = new Map(
						first.sessions.flatMap((session) =>
							session.sourceRevision === undefined
								? []
								: [[session.localSessionId, session.sourceRevision]],
						),
					);
					return { ...adapter, first, known };
				}),
			);
			const parser = spyOn(JsonlSessionSource, "open");
			try {
				for (const { version, previous, module, first, known } of confirmed) {
					const revisions = new Map(
						[...known].map(([id, revision]) => [
							id,
							version === changedVersion ? revision.replace(version, previous) : revision,
						]),
					);
					parser.mockClear();
					const result = await scan(module, revisions);
					const reparse = version === changedVersion || known.size === 0;
					expect(result.sessions).toHaveLength(reparse ? first.sessions.length : 0);
					expect(result.observedLocalSessionIds).toEqual(first.observedLocalSessionIds);
					if (reparse) expect(parser).toHaveBeenCalled();
					else expect(parser).not.toHaveBeenCalled();
					for (const session of result.sessions)
						expect(session.sourceRevision).toBe(known.get(session.localSessionId));
					const next = await scan(module, known);
					expect(next.sessions).toHaveLength(known.size ? 0 : first.sessions.length);
				}
			} finally {
				parser.mockRestore();
			}
		},
	);

	test.each(["pi-v1", "claude-v1"])("%s re-reads unversioned history once", async (version) => {
		const adapter = adapters().find((adapter) => adapter.version === version);
		if (!adapter) throw new Error("expected adapter fixture");
		const first = await scan(adapter.module);
		const known = new Map(
			first.sessions.flatMap((session) =>
				session.sourceRevision === undefined
					? []
					: [[session.localSessionId, session.sourceRevision]],
			),
		);
		const legacy = new Map(
			[...known].map(([id, revision]) => [id, revision.slice(version.length + 1)]),
		);
		const migrated = await scan(adapter.module, legacy);
		expect(migrated.sessions).toHaveLength(first.sessions.length);
		for (const session of migrated.sessions)
			expect(session.sourceRevision).toBe(known.get(session.localSessionId));
		expect((await scan(adapter.module, known)).sessions).toHaveLength(
			known.size ? 0 : first.sessions.length,
		);
	});
});
