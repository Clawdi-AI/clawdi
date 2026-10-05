import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readRuntimeAppliedState, writeRuntimeAppliedState } from "./applied-state";
import { gatewayOomProtectionLines } from "./oom-protection";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { applySystemdRuntimeUpdate, readSystemdUnitSnapshot } from "./systemd-transaction";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";

const roots: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const key of ["CLAWDI_SYSTEMD_APPLY", "CLAWDI_SYSTEMCTL_PATH", "CLAWDI_RUNTIME_USER"]) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

const gateway = "openclaw-gateway.service";
const daemon = "clawdi-daemon.service";
const base = "[Service]\nExecStart=/usr/bin/openclaw gateway run\nKillMode=process\n";
const oom = gatewayOomProtectionLines("openclaw", 4 * 1024 ** 3).join("\n");
const environment = 'CLAWDI_AI_API_KEY="clawdi-egress-placeholder"\n';

function fixture(): { paths: RuntimePaths; dropIn: string; env: string; log: string } {
	const root = mkdtempSync(join(tmpdir(), "clawdi-receipt-migration-"));
	roots.push(root);
	const paths = {
		...getRuntimePaths({ mode: "local" }),
		serviceStateRoot: root,
		statusRoot: join(root, "status"),
		systemdSystemRoot: join(root, "system"),
		systemdUserRoot: join(root, "user"),
		systemdEnvRoot: join(root, "env"),
		appliedState: join(root, "status", "runtime-applied.json"),
	};
	const dropIn = join(paths.systemdUserRoot, `${gateway}.d`, "10-clawdi-hosted.conf");
	const env = join(paths.systemdEnvRoot, `${gateway}.env`);
	for (const path of [dropIn, env, join(paths.systemdSystemRoot, daemon)])
		mkdirSync(dirname(path), { recursive: true });
	writeFileSync(join(paths.systemdUserRoot, gateway), base);
	writeFileSync(env, environment);
	writeFileSync(
		join(paths.systemdSystemRoot, daemon),
		"[Service]\nExecStart=/usr/bin/clawdi serve\n",
	);
	writeFileSync(join(paths.systemdEnvRoot, `${daemon}.env`), 'CLI="0.14.101"\n');
	const log = join(root, "commands.log");
	const command = join(root, "systemctl");
	writeFileSync(
		command,
		`#!/bin/sh
echo "$*" >> '${log}'
if [ "$1" = --user ]; then shift; fi
case "$1" in
show) printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nNeedDaemonReload=no\\nJob=\\n' ;;
is-enabled) printf 'enabled\\n' ;;
esac
`,
		{ mode: 0o755 },
	);
	process.env.CLAWDI_SYSTEMD_APPLY = "1";
	process.env.CLAWDI_SYSTEMCTL_PATH = command;
	process.env.CLAWDI_RUNTIME_USER = "root";
	return { paths, dropIn, env, log };
}

function commit(paths: RuntimePaths, activated: Record<string, string>): void {
	writeRuntimeAppliedState(
		{
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: new Date().toISOString(),
			instanceId: "receipt-fixture",
			etag: "receipt-fixture",
			sourceRevision: "a".repeat(64),
			generation: 1,
			contentIdentity: { sourcePath: "fixture", sha256: "b".repeat(64) },
			activated,
			providerIds: [],
			projectedProviderIds: {},
		},
		paths,
	);
}

function dropInContents(withOom: boolean): string {
	return `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\n${withOom ? `${oom}\n` : ""}EnvironmentFile=/run/clawdi/systemd/env/${gateway}.env\n`;
}

// Independent reproductions of the two released digest formats. The old
// receipt must not be seeded with the new reader, which hid this regression.
function releasedReceipt(version: "0.14.101" | "0.14.102", dropIn: string): string {
	let contents = dropIn;
	if (version === "0.14.102") {
		contents = contents
			.replace(`${oom}\n`, "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"))
			.join("\n");
	}
	return createHash("sha256").update(`${base}\n${contents}`).update(environment).digest("hex");
}

for (const version of ["0.14.101", "0.14.102"] as const) {
	for (const withOom of [false, true]) {
		test(`${version} receipt with OOM=${withOom}: handoff and drift re-apply preserve the gateway`, () => {
			const f = fixture();
			writeFileSync(f.dropIn, dropInContents(withOom));
			const before = readSystemdUnitSnapshot(f.paths);
			commit(f.paths, {
				...Object.fromEntries(before.system),
				[gateway]: releasedReceipt(version, readFileSync(f.dropIn, "utf8")),
			});
			writeFileSync(f.dropIn, dropInContents(true));
			writeFileSync(join(f.paths.systemdEnvRoot, `${daemon}.env`), 'CLI="0.14.103"\n');
			const after = readSystemdUnitSnapshot(f.paths);
			const handoff = applySystemdRuntimeUpdate(f.paths, before, after, {});
			expect(handoff).toMatchObject({
				applied: true,
				userUnitsChanged: [],
				systemUnitsChanged: [daemon],
			});
			expect(readFileSync(f.log, "utf8")).toContain(`restart ${daemon}`);
			expect(readFileSync(f.log, "utf8")).not.toContain(`restart ${gateway}`);
			if (!withOom) expect(readFileSync(f.log, "utf8")).toContain("--user daemon-reload");
			commit(f.paths, handoff.activated);
			writeFileSync(f.log, "");
			const repeated = readSystemdUnitSnapshot(f.paths);
			const drift = applySystemdRuntimeUpdate(f.paths, repeated, repeated, {});
			expect(drift).toMatchObject({ applied: true, userUnitsChanged: [], systemUnitsChanged: [] });
			expect(readFileSync(f.log, "utf8")).not.toMatch(/daemon-reload|\b(start|restart|stop)\b/);
			expect(readFileSync(join(f.paths.systemdUserRoot, gateway), "utf8")).toBe(base);
			expect(readRuntimeAppliedState(f.paths)?.activated[gateway]).toBe(after.user.get(gateway));
		});
	}
}

test("Hosted capability withdrawal and restoration each require activation; unchanged drift does not", () => {
	const f = fixture();
	writeFileSync(f.dropIn, dropInContents(true));
	const initial = readSystemdUnitSnapshot(f.paths);
	commit(f.paths, Object.fromEntries([...initial.system, ...initial.user]));
	// The incident's 129/130 sources actually withdraw, then restore the
	// credential environment. The CLI must not mislabel these as receipt migration.
	let before = initial;
	for (const contents of ["", environment]) {
		writeFileSync(f.env, contents);
		const after = readSystemdUnitSnapshot(f.paths);
		const apply = applySystemdRuntimeUpdate(f.paths, before, after, {});
		expect(apply).toMatchObject({ applied: true, userUnitsChanged: [gateway] });
		commit(f.paths, apply.activated);
		before = after;
	}
	expect(
		readFileSync(f.log, "utf8").match(/^--user restart openclaw-gateway.service$/gm),
	).toHaveLength(2);
	writeFileSync(f.log, "");
	expect(applySystemdRuntimeUpdate(f.paths, before, before, {}).userUnitsChanged).toEqual([]);
	expect(readFileSync(f.log, "utf8")).not.toMatch(/\b(start|restart|stop)\b/);
});

test("migration cannot bless a credential mutation that preceded the snapshot", () => {
	const f = fixture();
	writeFileSync(f.dropIn, dropInContents(false));
	commit(f.paths, { [gateway]: releasedReceipt("0.14.101", readFileSync(f.dropIn, "utf8")) });
	writeFileSync(f.env, 'CLAWDI_AI_API_KEY="changed"\n');
	const before = readSystemdUnitSnapshot(f.paths);
	writeFileSync(f.dropIn, dropInContents(true));
	expect(
		applySystemdRuntimeUpdate(f.paths, before, readSystemdUnitSnapshot(f.paths), {})
			.userUnitsChanged,
	).toEqual([gateway]);
});

test("unknown directives inside OOM markers and base-unit bytes remain activation relevant", () => {
	const f = fixture();
	writeFileSync(f.dropIn, dropInContents(true));
	const before = readSystemdUnitSnapshot(f.paths);
	commit(f.paths, Object.fromEntries([...before.system, ...before.user]));
	writeFileSync(
		f.dropIn,
		dropInContents(true).replace("OOMPolicy=continue", "OOMPolicy=continue\nExecStart=/bin/false"),
	);
	expect(
		applySystemdRuntimeUpdate(f.paths, before, readSystemdUnitSnapshot(f.paths), {})
			.userUnitsChanged,
	).toEqual([gateway]);
	writeFileSync(f.dropIn, dropInContents(true));
	writeFileSync(join(f.paths.systemdUserRoot, gateway), `${base}Environment=EXTRA=1\n`);
	expect(
		applySystemdRuntimeUpdate(f.paths, before, readSystemdUnitSnapshot(f.paths), {})
			.userUnitsChanged,
	).toEqual([gateway]);
});
