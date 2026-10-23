import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../serve/log";
import { readRuntimeAppliedState, writeRuntimeAppliedState } from "./applied-state";
import { gatewayOomProtectionLines } from "./oom-protection";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import {
	clearSystemdActivationJournal,
	readSystemdActivationJournal,
} from "./systemd-activation-journal";
import {
	applySystemdRuntimeUpdate,
	readSystemdUnitSnapshot,
	withoutStaleSystemdUnits,
} from "./systemd-transaction";
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

function fixture(
	options: {
		activeState?: "active" | "inactive" | "failed";
		needDaemonReload?: "yes" | "no";
		gatewayUnit?: "hermes-gateway.service" | "openclaw-gateway.service";
	} = {},
): {
	paths: RuntimePaths;
	gateway: string;
	dropIn: string;
	env: string;
	baseUnit: string;
	log: string;
	activationAtCommand: string;
} {
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
	const gatewayUnit = options.gatewayUnit ?? gateway;
	const dropIn = join(paths.systemdUserRoot, `${gatewayUnit}.d`, "10-clawdi-hosted.conf");
	const env = join(paths.systemdEnvRoot, `${gatewayUnit}.env`);
	const baseUnit = join(paths.systemdUserRoot, gatewayUnit);
	const activeState = join(root, "active-state");
	const needDaemonReload = join(root, "need-daemon-reload");
	for (const path of [dropIn, env, join(paths.systemdSystemRoot, daemon)])
		mkdirSync(dirname(path), { recursive: true });
	writeFileSync(baseUnit, base);
	writeFileSync(env, environment);
	writeFileSync(activeState, options.activeState ?? "active");
	writeFileSync(needDaemonReload, options.needDaemonReload ?? "no");
	writeFileSync(
		join(paths.systemdSystemRoot, daemon),
		"[Service]\nExecStart=/usr/bin/clawdi serve\n",
	);
	writeFileSync(join(paths.systemdEnvRoot, `${daemon}.env`), 'CLI="0.14.101"\n');
	const log = join(root, "commands.log");
	const activationAtCommand = join(root, "activation-at-command.json");
	const command = join(root, "systemctl");
	writeFileSync(
		command,
		`#!/bin/sh
echo "$*" >> '${log}'
if [ "$1" = --user ]; then shift; fi
case "$1" in
show)
  state=$(cat '${activeState}')
  reload=$(cat '${needDaemonReload}')
  printf 'LoadState=loaded\\nActiveState=%s\\nSubState=running\\nNeedDaemonReload=%s\\nJob=\\n' "$state" "$reload"
  ;;
is-enabled) printf 'enabled\\n' ;;
daemon-reload) printf 'no' > '${needDaemonReload}' ;;
start|restart)
  if [ -f '${join(dirname(paths.appliedState), "systemd-activation-journal.json")}' ]; then
    cp '${join(dirname(paths.appliedState), "systemd-activation-journal.json")}' '${activationAtCommand}'
  fi
  printf 'active' > '${activeState}' ;;
stop) printf 'inactive' > '${activeState}' ;;
esac
`,
		{ mode: 0o755 },
	);
	process.env.CLAWDI_SYSTEMD_APPLY = "1";
	process.env.CLAWDI_SYSTEMCTL_PATH = command;
	process.env.CLAWDI_RUNTIME_USER = "root";
	return { paths, gateway: gatewayUnit, dropIn, env, baseUnit, log, activationAtCommand };
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

function dropInContents(withOom: boolean, unit = gateway): string {
	return `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\n${withOom ? `${oom}\n` : ""}EnvironmentFile=/run/clawdi/systemd/env/${unit}.env\n`;
}

// Independent reproductions of the released digest formats. The old
// receipt must not be seeded with the new reader, which hid this regression.
function releasedReceipt(version: "0.14.101" | "0.14.102" | "0.14.103", dropIn: string): string {
	let contents = dropIn;
	if (version === "0.14.102") {
		contents = contents
			.replace(`${oom}\n`, "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"))
			.join("\n");
	} else if (version === "0.14.103") {
		contents = contents.replace(`${oom}\n`, "");
	}
	return createHash("sha256").update(`${base}\n${contents}`).update(environment).digest("hex");
}

for (const [version, label] of [
	["0.14.101", "0.14.101"],
	["0.14.102", "0.14.102"],
	["0.14.103", "0.14.103 through 0.16.16"],
] as const) {
	for (const withOom of [false, true]) {
		test(`${label} receipt with OOM=${withOom}: handoff and drift re-apply preserve the gateway`, () => {
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

for (const gatewayUnit of ["hermes-gateway.service", "openclaw-gateway.service"] as const) {
	test(`${gatewayUnit}: 0.14.103 through 0.16.16 receipt: pre-handoff base rewrite restarts once, then converges`, () => {
		const f = fixture({ gatewayUnit });
		writeFileSync(f.dropIn, dropInContents(true, f.gateway));
		const committed = readSystemdUnitSnapshot(f.paths);
		commit(f.paths, {
			...Object.fromEntries(committed.system),
			[f.gateway]: releasedReceipt("0.14.103", readFileSync(f.dropIn, "utf8")),
		});

		// The native installer rewrites its base unit before the new CLI takes its
		// handoff snapshot. The old combined receipt cannot prove this is harmless.
		writeFileSync(f.baseUnit, `${base}Environment=PRE_HANDOFF=1\n`);
		const handoff = readSystemdUnitSnapshot(f.paths);
		const firstApply = applySystemdRuntimeUpdate(f.paths, handoff, handoff, {});
		expect(firstApply.applied).toBe(true);
		let commands = readFileSync(f.log, "utf8");
		expect(commands.match(new RegExp(`^--user restart ${f.gateway}$`, "gm"))).toHaveLength(1);
		commit(f.paths, firstApply.activated);

		writeFileSync(f.log, "");
		const repeated = readSystemdUnitSnapshot(f.paths);
		expect(applySystemdRuntimeUpdate(f.paths, handoff, repeated, {}).applied).toBe(true);
		expect(readFileSync(f.log, "utf8")).not.toMatch(/daemon-reload|\b(start|restart|stop)\b/);

		writeFileSync(f.log, "");
		const beforeFurtherRewrite = readSystemdUnitSnapshot(f.paths);
		writeFileSync(f.baseUnit, `${base}Environment=POST_HANDOFF=1\n`);
		const afterFurtherRewrite = readSystemdUnitSnapshot(f.paths);
		expect(
			applySystemdRuntimeUpdate(f.paths, beforeFurtherRewrite, afterFurtherRewrite, {}).applied,
		).toBe(true);
		commands = readFileSync(f.log, "utf8");
		expect(commands).toContain("--user daemon-reload");
		expect(commands).not.toMatch(/\b(start|restart|stop)\b/);
	});
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

test("invalidated active user units restart even with an unchanged fingerprint", () => {
	const f = fixture();
	writeFileSync(f.dropIn, dropInContents(true));
	const snapshot = readSystemdUnitSnapshot(f.paths);
	commit(f.paths, Object.fromEntries([...snapshot.system, ...snapshot.user]));
	const apply = applySystemdRuntimeUpdate(f.paths, snapshot, snapshot, {
		invalidatedUserUnits: [gateway],
	});
	expect(apply.applied).toBe(true);
	expect(readFileSync(f.log, "utf8")).toContain(`--user restart ${gateway}`);
});

for (const gatewayUnit of ["hermes-gateway.service", "openclaw-gateway.service"] as const) {
	for (const damaged of ["environment", "drop-in"] as const) {
		test(`${gatewayUnit}: repairing a partial ${damaged} write preserves the committed activation`, () => {
			const f = fixture({ gatewayUnit });
			writeFileSync(f.dropIn, dropInContents(true, f.gateway));
			const committed = readSystemdUnitSnapshot(f.paths);
			commit(f.paths, Object.fromEntries([...committed.system, ...committed.user]));
			const file = damaged === "environment" ? f.env : f.dropIn;
			const desired = readFileSync(file, "utf8");
			writeFileSync(
				file,
				damaged === "environment"
					? 'CLAWDI_AI_API_KEY="partial'
					: `${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\n`,
			);
			const before = readSystemdUnitSnapshot(f.paths);
			writeFileSync(file, desired);
			const after = readSystemdUnitSnapshot(f.paths);
			expect(before.user).not.toEqual(after.user);
			expect(after.user).toEqual(committed.user);
			const apply = applySystemdRuntimeUpdate(f.paths, before, after, {});
			expect(apply).toMatchObject({ applied: true, userUnitsChanged: [] });
			expect(readFileSync(f.log, "utf8")).not.toMatch(/\b(start|restart|stop)\b/);
			commit(f.paths, apply.activated);
			writeFileSync(f.log, "");
			expect(applySystemdRuntimeUpdate(f.paths, after, after, {}).applied).toBe(true);
			expect(readFileSync(f.log, "utf8")).not.toMatch(/daemon-reload|\b(start|restart|stop)\b/);
		});
	}
}

for (const version of ["0.14.101", "0.14.102", "0.14.103"] as const) {
	test(`${version}: repairing drift with only a legacy candidate match conservatively activates once`, () => {
		const f = fixture();
		writeFileSync(f.dropIn, dropInContents(true));
		const committed = readSystemdUnitSnapshot(f.paths);
		commit(f.paths, {
			...Object.fromEntries(committed.system),
			[gateway]: releasedReceipt(version, readFileSync(f.dropIn, "utf8")),
		});
		writeFileSync(f.env, 'CLAWDI_AI_API_KEY="partial');
		const before = readSystemdUnitSnapshot(f.paths);
		writeFileSync(f.env, environment);
		const after = withoutStaleSystemdUnits(readSystemdUnitSnapshot(f.paths), [], []);
		const apply = applySystemdRuntimeUpdate(f.paths, before, after, {});
		expect(apply).toMatchObject({ applied: true, userUnitsChanged: [gateway] });
		expect(readFileSync(f.log, "utf8")).toContain(`--user restart ${gateway}`);
		expect(apply.activated).toEqual(Object.fromEntries([...after.system, ...after.user]));
		commit(f.paths, apply.activated);
		writeFileSync(f.log, "");
		expect(applySystemdRuntimeUpdate(f.paths, after, after, {}).userUnitsChanged).toEqual([]);
		expect(readFileSync(f.log, "utf8")).not.toMatch(/\b(start|restart|stop)\b/);
	});
}

for (const gatewayUnit of ["hermes-gateway.service", "openclaw-gateway.service"] as const) {
	test(`${gatewayUnit}: retrying committed A with matching uncommitted activation does not restart`, () => {
		const f = fixture({ gatewayUnit, activeState: "inactive" });
		writeFileSync(f.dropIn, dropInContents(true, f.gateway));
		const a = readSystemdUnitSnapshot(f.paths);
		commit(f.paths, Object.fromEntries([...a.system, ...a.user]));
		expect(applySystemdRuntimeUpdate(f.paths, a, a, {}).userUnitsChanged).toEqual([f.gateway]);
		expect(readFileSync(f.log, "utf8")).toContain(`--user start ${f.gateway}`);
		// An unrelated install error blocks commit after recovery. Keep the intent.
		expect(readSystemdActivationJournal(f.paths)).toEqual(Object.fromEntries(a.user));
		writeFileSync(f.log, "");
		expect(applySystemdRuntimeUpdate(f.paths, a, a, {}).userUnitsChanged).toEqual([]);
		expect(readFileSync(f.log, "utf8")).not.toMatch(/\b(start|restart|stop)\b/);
		expect(readSystemdActivationJournal(f.paths)).toEqual(Object.fromEntries(a.user));
	});

	test(`${gatewayUnit}: a late failure replays committed A over the running uncommitted B`, () => {
		const f = fixture({ gatewayUnit });
		writeFileSync(f.dropIn, dropInContents(true, f.gateway));
		const a = readSystemdUnitSnapshot(f.paths);
		commit(f.paths, Object.fromEntries([...a.system, ...a.user]));
		writeFileSync(f.env, 'CLAWDI_AI_API_KEY="candidate-B"\n');
		const b = readSystemdUnitSnapshot(f.paths);
		expect(applySystemdRuntimeUpdate(f.paths, a, b, {}).userUnitsChanged).toEqual([f.gateway]);
		expect(readSystemdActivationJournal(f.paths)).toEqual(Object.fromEntries(b.user));
		expect(JSON.parse(readFileSync(f.activationAtCommand, "utf8")).pending).toEqual(
			Object.fromEntries(b.user),
		);
		// A readiness failure after activation leaves the receipt at A.
		expect(readRuntimeAppliedState(f.paths)?.activated[f.gateway]).toBe(a.user.get(f.gateway));
		writeFileSync(f.env, environment);
		writeFileSync(f.log, "");
		const restored = readSystemdUnitSnapshot(f.paths);
		const replay = applySystemdRuntimeUpdate(f.paths, b, restored, {});
		expect(replay.userUnitsChanged).toEqual([f.gateway]);
		expect(readFileSync(f.log, "utf8")).toContain(`--user restart ${f.gateway}`);
		// Only the successful replay proof acknowledges intent without a new receipt.
		clearSystemdActivationJournal(f.paths);
		writeFileSync(f.log, "");
		expect(applySystemdRuntimeUpdate(f.paths, restored, restored, {}).userUnitsChanged).toEqual([]);
		expect(readFileSync(f.log, "utf8")).not.toMatch(/\b(start|restart|stop)\b/);
	});

	test(`${gatewayUnit}: crash after restart retains intent for a fresh process replaying A`, async () => {
		const f = fixture({ gatewayUnit });
		writeFileSync(f.dropIn, dropInContents(true, f.gateway));
		const a = readSystemdUnitSnapshot(f.paths);
		commit(f.paths, Object.fromEntries([...a.system, ...a.user]));
		const run = async () => {
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`
import { applySystemdRuntimeUpdate, readSystemdUnitSnapshot } from ${JSON.stringify(join(import.meta.dir, "systemd-transaction.ts"))};
const paths = JSON.parse(process.argv[1]);
const snapshot = readSystemdUnitSnapshot(paths);
applySystemdRuntimeUpdate(paths, snapshot, snapshot, {});
process.exit(23);
`,
					JSON.stringify(f.paths),
				],
				{
					env: { ...process.env },
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
					timeout: 5000,
				},
			);
			const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			return { status, stderr };
		};
		writeFileSync(f.env, 'CLAWDI_AI_API_KEY="candidate-B"\n');
		const crashed = await run();
		expect(crashed.status, crashed.stderr).toBe(23);
		expect(readFileSync(f.log, "utf8")).toContain(`--user restart ${f.gateway}`);
		const b = readSystemdUnitSnapshot(f.paths);
		expect(readSystemdActivationJournal(f.paths)).toEqual(Object.fromEntries(b.user));
		// The previous process and in-memory snapshots are gone; receipt still says A.
		writeFileSync(f.env, environment);
		writeFileSync(f.log, "");
		const recovered = await run();
		expect(recovered.status, recovered.stderr).toBe(23);
		expect(readFileSync(f.log, "utf8")).toContain(`--user restart ${f.gateway}`);
		commit(f.paths, Object.fromEntries([...a.system, ...a.user]));
		expect(readSystemdActivationJournal(f.paths)).toEqual({});
	});
}

test("a desired environment write interrupted before activation still restarts once", () => {
	const f = fixture();
	writeFileSync(f.dropIn, dropInContents(true));
	const committed = readSystemdUnitSnapshot(f.paths);
	commit(f.paths, Object.fromEntries([...committed.system, ...committed.user]));
	writeFileSync(f.env, 'CLAWDI_AI_API_KEY="new-desired-value"\n');
	const recovered = readSystemdUnitSnapshot(f.paths);
	const apply = applySystemdRuntimeUpdate(f.paths, recovered, recovered, {});
	expect(apply).toMatchObject({ applied: true, userUnitsChanged: [gateway] });
	expect(readFileSync(f.log, "utf8")).toContain(`--user restart ${gateway}`);
	commit(f.paths, apply.activated);
	writeFileSync(f.log, "");
	expect(applySystemdRuntimeUpdate(f.paths, recovered, recovered, {}).applied).toBe(true);
	expect(readFileSync(f.log, "utf8")).not.toMatch(/\b(start|restart|stop)\b/);
});

for (const scope of ["system", "user"] as const) {
	test(`${scope} restart diagnostics identify changed paths and keys without secret values`, () => {
		const f = fixture();
		writeFileSync(f.dropIn, dropInContents(true));
		const unit = scope === "system" ? daemon : gateway;
		const envPath = join(f.paths.systemdEnvRoot, `${unit}.env`);
		writeFileSync(
			envPath,
			'CHANGED="old-secret"\nREMOVED="removed-secret"\nSAME="stable-secret"\n',
		);
		const before = readSystemdUnitSnapshot(f.paths);
		commit(f.paths, Object.fromEntries([...before.system, ...before.user]));
		const committed = readRuntimeAppliedState(f.paths);
		writeFileSync(envPath, 'ADDED="added-secret"\nCHANGED="new-secret"\nSAME="stable-secret"\n');
		const unitPath = scope === "system" ? join(f.paths.systemdSystemRoot, unit) : f.baseUnit;
		writeFileSync(
			unitPath,
			`${readFileSync(unitPath, "utf8")}Environment=UNIT_TOKEN=unit-secret\n`,
		);
		if (scope === "user")
			writeFileSync(f.dropIn, `${dropInContents(true)}Environment=DROP_TOKEN=drop-secret\n`);
		const after = withoutStaleSystemdUnits(readSystemdUnitSnapshot(f.paths), [], []);
		const logger = spyOn(log, "info").mockImplementation(() => {});
		try {
			applySystemdRuntimeUpdate(f.paths, before, after, {
				desiredIdentity: { generation: 2, sourceRevision: "c".repeat(64) },
			});
			expect(logger).toHaveBeenCalledWith(
				"runtime.systemd_restart",
				expect.objectContaining({
					scope,
					unit,
					beforeFingerprint: before[scope].get(unit),
					candidateFingerprint: after[scope].get(unit),
					committedFingerprint: committed?.activated?.[unit],
					committedActivationFingerprint: before[scope].get(unit),
					committedGeneration: 1,
					committedSourceRevision: "a".repeat(64),
					committedAppliedAt: committed?.appliedAt,
					desiredGeneration: 2,
					desiredSourceRevision: "c".repeat(64),
					changedFiles: scope === "system" ? [unitPath, envPath] : [unitPath, f.dropIn, envPath],
					changedEnvironmentKeys: ["ADDED", "CHANGED", "REMOVED"],
				}),
			);
			const output = JSON.stringify(logger.mock.calls);
			for (const value of [
				"old-secret",
				"removed-secret",
				"stable-secret",
				"added-secret",
				"new-secret",
				"unit-secret",
				"drop-secret",
			])
				expect(output).not.toContain(value);
		} finally {
			logger.mockRestore();
		}
	});
}

test("unknown directives inside OOM markers remain activation relevant", () => {
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
});

for (const needDaemonReload of ["no", "yes"] as const) {
	test(`official base-unit rewrites do not restart an active gateway (NeedDaemonReload=${needDaemonReload})`, () => {
		const f = fixture({ needDaemonReload });
		writeFileSync(f.dropIn, dropInContents(true));
		const before = readSystemdUnitSnapshot(f.paths);
		commit(f.paths, {
			...Object.fromEntries(before.system),
			[gateway]: releasedReceipt("0.14.103", readFileSync(f.dropIn, "utf8")),
		});
		writeFileSync(f.baseUnit, `${base}Environment=EXTRA=1\n`);
		const after = readSystemdUnitSnapshot(f.paths);
		expect(after.user.get(gateway)).toBe(before.user.get(gateway));
		expect(after.reload?.user.get(gateway)).not.toBe(before.reload?.user.get(gateway));
		expect(applySystemdRuntimeUpdate(f.paths, before, after, {})).toMatchObject({
			applied: true,
			userUnitsChanged: [],
			systemUnitsChanged: [],
		});
		const commands = readFileSync(f.log, "utf8");
		expect(commands).not.toMatch(/\b(start|restart|stop)\b/);
		expect(commands).toContain("--user daemon-reload");
	});
}

test("Clawdi-owned base-unit changes restart active services", () => {
	const f = fixture();
	writeFileSync(f.dropIn, dropInContents(true));
	const before = readSystemdUnitSnapshot(f.paths);
	commit(f.paths, Object.fromEntries([...before.system, ...before.user]));
	writeFileSync(
		join(f.paths.systemdSystemRoot, daemon),
		"[Service]\nExecStart=/usr/bin/clawdi serve --changed\n",
	);
	const apply = applySystemdRuntimeUpdate(f.paths, before, readSystemdUnitSnapshot(f.paths), {});
	expect(apply).toMatchObject({ applied: true, systemUnitsChanged: [daemon] });
	expect(readFileSync(f.log, "utf8")).toContain(`restart ${daemon}`);
});

for (const activeState of ["inactive", "failed"] as const) {
	test(`official base-unit rewrites use the normal ${activeState} recovery path`, () => {
		const f = fixture({ activeState });
		writeFileSync(f.dropIn, dropInContents(true));
		const before = readSystemdUnitSnapshot(f.paths);
		commit(f.paths, Object.fromEntries([...before.system, ...before.user]));
		writeFileSync(f.baseUnit, `${base}Environment=EXTRA=1\n`);
		const apply = applySystemdRuntimeUpdate(f.paths, before, readSystemdUnitSnapshot(f.paths), {});
		expect(apply).toMatchObject({ applied: true, userUnitsChanged: [gateway] });
		const commands = readFileSync(f.log, "utf8");
		expect(commands).toContain(`--user start ${gateway}`);
		expect(commands).not.toContain(`--user restart ${gateway}`);
	});
}
