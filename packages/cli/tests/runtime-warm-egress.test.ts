import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRuntimeManifestLoad } from "../src/commands/runtime";
import {
	adoptableWarmEgress,
	egressSnapshotPaths,
	publishEgressSnapshot,
	waitForEgressSnapshot,
} from "../src/runtime/egress-snapshot";
import { hermesWarmMarker } from "../src/runtime/hermes-warm-state";
import * as manifest from "../src/runtime/manifest";
import { RUNTIME_DESIRED_STATE_SCHEMA_VERSION } from "../src/runtime/manifest-contract";
import { runtimeConvergenceWithoutApply } from "../src/runtime/manifest-planning";
import type { RuntimeManifestLoad } from "../src/runtime/manifest-source";
import { getRuntimePaths } from "../src/runtime/paths";
import {
	generateAnonymousEgressCa,
	warmAnonymousEgressSidecar,
} from "../src/runtime/runtime-warm-egress";
import { ensureRuntimeStateDirs } from "../src/runtime/state";
import * as systemd from "../src/runtime/systemd-transaction";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "../src/runtime/systemd-user";

const environment = { ...process.env };
const originalUmask = process.umask();
const roots: string[] = [];
const sidecar = "clawdi-runtime-sidecar.service";
const dashboard = "clawdi-hermes-dashboard.service";
const gateway = "hermes-gateway.service";
const pin = {
	type: "mitmproxy" as const,
	version: "12.2.3",
	url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
	sha256: "a".repeat(64),
};

afterEach(() => {
	mock.restore();
	process.env = { ...environment };
	process.umask(originalUmask);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, contents: string, mode = 0o600) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
	writeFileSync(path, contents, { mode });
}

function fixture(withPin = true) {
	const root = mkdtempSync(join(tmpdir(), "clawdi-warm-egress-"));
	roots.push(root);
	chmodSync(root, 0o755);
	const uid = process.getuid?.() || 10001;
	const gid = process.getgid?.() || 10001;
	Object.assign(process.env, {
		CLAWDI_RUNTIME_HOME: join(root, "home"),
		CLAWDI_SERVICE_STATE_DIR: join(root, "state"),
		CLAWDI_RUN_DIR: join(root, "run"),
		CLAWDI_SYSTEMD_SYSTEM_ROOT: join(root, "run/systemd/system"),
		CLAWDI_SYSTEMD_APPLY: "1",
		CLAWDI_SYSTEMCTL_PATH: join(root, "bin/systemctl"),
		CLAWDI_RUNTIME_USER: String(process.getuid?.() ?? 1000),
		CLAWDI_EGRESS_UID: String(process.getuid?.() || 10002),
		CLAWDI_EGRESS_GID: String(process.getgid?.() || 10002),
		PATH: `${join(root, "bin")}:${process.env.PATH}`,
	});
	delete process.env.CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY;
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	mkdirSync(paths.userHome, { recursive: true, mode: 0o755 });
	mkdirSync(paths.systemdUserRoot, { recursive: true, mode: 0o755 });
	const files = egressSnapshotPaths(paths);
	write(
		join(paths.serviceStateRoot, "preinstallation/receipt.json"),
		JSON.stringify({
			schemaVersion: "clawdi.runtime-preinstallation.v1",
			imageFingerprint: "b".repeat(64),
			architecture: process.arch,
			cliPackageSpec: "clawdi@1.2.3",
			runtime: "hermes",
			...(withPin ? { egressEngine: pin } : {}),
			preparedAt: "2026-10-10T00:00:00Z",
		}),
		0o400,
	);
	// The maintained binary stands in for the already SHA-verified archive. It
	// creates an actual instance-local CA under the configured egress identity.
	write(
		join(paths.egressEngineMaintainedRoot, pin.version, pin.sha256, "mitmdump"),
		`#!/bin/sh
set -eu
confdir=
for arg in "$@"; do case "$arg" in confdir=*) confdir="\${arg#confdir=}" ;; esac; done
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Anonymous-warm-test \\
 -keyout "$confdir/mitmproxy-ca.pem" -out "$confdir/mitmproxy-ca-cert.pem" >/dev/null 2>&1
exec /bin/sleep 30
`,
		0o755,
	);
	const log = join(root, "commands");
	const manager = join(root, "manager");
	mkdirSync(manager, { mode: 0o755 });
	write(join(root, "bin/curl"), "#!/bin/sh\necho 200\n", 0o755);
	write(
		join(root, "bin/systemctl"),
		`#!/bin/bash
set -eu
echo "$*" >> '${log}'
scope=system
if [ "$1" = --user ]; then scope=user; shift; fi
op=$1; shift
case "$op" in
show)
 for unit in "$@"; do
  [[ "$unit" != --* ]] || continue
  active=inactive; [ ! -f '${manager}/'$scope-$unit.active ] || active=active
  printf 'Id=%s\\nLoadState=loaded\\nActiveState=%s\\nNeedDaemonReload=no\\nJob=\\nInvocationID=%032x\\n\\n' "$unit" "$active" 1
 done ;;
cat) [ "$1" != --no-pager ] || shift; cat '${paths.systemdSystemRoot}/'$1 ;;
is-enabled) for unit in "$@"; do echo enabled; done ;;
start|restart)
 for unit in "$@"; do
  touch '${manager}/'$scope-$unit.active
  if [ "$unit" = '${sidecar}' ]; then
   sha256sum '${files.input}' | cut -d ' ' -f 1 > '${files.ack}'
   chmod 600 '${files.ack}'
   ${process.getuid?.() === 0 ? `chown 10002:10002 '${files.ack}'` : ""}
  fi
 done ;;
daemon-reload|enable|reset-failed) ;;
*) exit 2 ;;
esac
`,
		0o755,
	);
	return { paths, files, log, identity: { uid, gid } };
}

test("receipt egress pin generates a private CA, starts anonymous egress and seals its marker", async () => {
	const f = fixture();
	await generateAnonymousEgressCa(f.paths, f.identity.gid);
	const certificate = readFileSync(f.paths.egressCaCert, "utf8");
	expect(new X509Certificate(certificate).subject).toBe("CN=Anonymous-warm-test");
	expect(statSync(f.paths.egressCaDir).mode & 0o777).toBe(0o700);
	expect(statSync(f.paths.egressCaCert).uid).toBe(Number(process.env.CLAWDI_EGRESS_UID));
	expect(readFileSync(f.paths.egressSystemCaFile, "utf8")).toContain(certificate.trim());
	warmAnonymousEgressSidecar(f.paths, f.identity);
	expect(JSON.parse(readFileSync(f.files.warm, "utf8"))).toMatchObject({
		schemaVersion: "clawdi.egressWarm.v1",
		identity: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	expect(statSync(f.files.warm).mode & 0o777).toBe(0o600);
	expect(JSON.parse(readFileSync(f.files.input, "utf8"))).toEqual({
		schemaVersion: "clawdi.egressSnapshot.v1",
		claimed: false,
		profiles: { schemaVersion: "clawdi.egressProfiles.v1", profiles: [] },
		secrets: {},
	});
	// Exercise the real addon against the snapshot emitted by warm-up. Only the
	// root ownership check is simulated in the unprivileged clean runner.
	execFileSync(
		"python3",
		[
			"-c",
			`
import os, runpy, sys
from types import SimpleNamespace
from unittest.mock import patch
fixtures = runpy.run_path(sys.argv[1])
addon, Flow = fixtures["addon"], fixtures["Flow"]
native_fstat = os.fstat
def root_owned(fd):
    node = native_fstat(fd)
    return SimpleNamespace(st_mode=node.st_mode, st_size=node.st_size, st_uid=0)
with patch.object(addon.os, "fstat", side_effect=root_owned):
    engine = addon.ClawdiEgressAddon()
    engine.reload_from_environment({"CLAWDI_EGRESS_SNAPSHOT_FILE": sys.argv[2], "CLAWDI_EGRESS_SNAPSHOT_ACK": sys.argv[3]})
    for host in ["service.test", "unmanaged.test"]:
        flow = Flow(host=host)
        assert engine.should_intercept_sni(host)
        assert engine.apply_to_flow(flow).action == "deny"
        assert flow.response["status_code"] == 503
`,
			fileURLToPath(new URL("./egress_addon/clawdi_egress_addon_test.py", import.meta.url)),
			f.files.input,
			join(dirname(f.files.input), "test-ack"),
		],
		{ timeout: 5000 },
	);
	const before = readFileSync(f.paths.egressCaCert, "utf8");
	await generateAnonymousEgressCa(f.paths, f.identity.gid);
	expect(readFileSync(f.paths.egressCaCert, "utf8")).toBe(before);
});

test("receipt without optional assets keeps egress warm-up inactive", async () => {
	const f = fixture(false);
	await generateAnonymousEgressCa(f.paths, f.identity.gid);
	warmAnonymousEgressSidecar(f.paths, f.identity);
	expect(existsSync(f.paths.egressCaCert)).toBe(false);
	expect(existsSync(f.files.warm)).toBe(false);
	expect(existsSync(f.log)).toBe(false);
	expect(JSON.parse(readFileSync(f.files.input, "utf8")).claimed).toBe(false);
});

test.skipIf(process.getuid?.() !== 0).each([false, true])(
	"claim reuses only matching warm egress and overlaps Hermes: identity mismatch=%s",
	async (mismatch) => {
		// CI can use a permissive umask; fixture paths must remain trusted.
		process.umask(0);
		const f = fixture();
		await generateAnonymousEgressCa(f.paths, f.identity.gid);
		warmAnonymousEgressSidecar(f.paths, f.identity);
		expect(adoptableWarmEgress(f.paths)).toBe(true);
		const envFile = join(f.paths.systemdEnvRoot, `${sidecar}.env`);
		const originalEnv = readFileSync(envFile, "utf8");
		const tenantEnv = originalEnv.replace(
			/^CLAWDI_MANAGED_CONTENT_DIGEST=.*$/m,
			'CLAWDI_MANAGED_CONTENT_DIGEST="tenant"',
		);
		writeFileSync(envFile, tenantEnv);
		expect(adoptableWarmEgress(f.paths)).toBe(true);
		writeFileSync(envFile, originalEnv);
		if (mismatch)
			writeFileSync(
				f.paths.egressSystemCaFile,
				`${readFileSync(f.paths.egressSystemCaFile, "utf8")}\n`,
			);
		expect(adoptableWarmEgress(f.paths)).toBe(!mismatch);
		write(hermesWarmMarker(f.paths), "warmed\n");
		for (const unit of [dashboard, gateway])
			write(
				join(f.paths.systemdUserRoot, unit),
				`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\nExecStart=/fixture\n`,
			);
		const platform = "clawdi-platform-fixture.service";
		write(join(f.paths.systemdSystemRoot, platform), "[Service]\nExecStart=/fixture\n");
		const load: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
				workspaceRoot: f.paths.userHome,
				deploymentId: "dep_test",
				environmentId: "env_test",
				instanceId: "iid_test",
				generation: 1,
				issuedAt: "2026-10-10T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud.test" },
				runtimes: {},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://warm-claim",
			offline: false,
		};
		// Keep projection out of this orchestration test. Run the real claim
		// callbacks, identity/ACK checks and current systemd transaction code.
		spyOn(manifest, "convergeRuntimeManifest").mockImplementation((_load, paths, options) => {
			writeFileSync(envFile, tenantEnv);
			publishEgressSnapshot(
				paths,
				{ schemaVersion: "clawdi.egressProfiles.v1", profiles: [] },
				{},
				true,
			);
			execFileSync(process.env.CLAWDI_SYSTEMCTL_PATH ?? "systemctl", ["start", sidecar]);
			options?.systemdApply?.activateEgressPrerequisite({
				staleSystemUnits: [],
				staleUserUnits: [],
				invalidatedUserUnits: [],
			});
			options?.systemdApply?.activate({
				staleSystemUnits: [],
				staleUserUnits: [],
				invalidatedUserUnits: [],
			});
			return runtimeConvergenceWithoutApply({
				load,
				paths,
				workspaceRoot: paths.userHome,
				enabledRuntimes: [],
				installErrors: [],
				projectedProviderIds: {},
			});
		});
		const apply = spyOn(systemd, "applySystemdRuntimeUpdate");
		writeFileSync(f.log, "");
		const result = await applyRuntimeManifestLoad(load, f.paths);
		expect(result.kind).toBe("converged");
		expect(apply.mock.calls[0]?.[3]).toMatchObject({
			skipActivatedSystemUnits: mismatch ? [] : [sidecar],
		});
		expect(apply.mock.calls[1]?.[3]).toMatchObject({
			earlyFreshHermes: !mismatch,
			skipActivatedSystemUnits: [sidecar],
		});
		const calls = readFileSync(f.log, "utf8").trim().split("\n");
		expect(calls.includes(`restart ${sidecar}`)).toBe(mismatch);
		expect(calls.indexOf(`--user start ${dashboard}`)).toBeGreaterThan(-1);
		expect(calls.indexOf(`start ${platform}`)).toBeGreaterThan(-1);
		if (!mismatch)
			expect(calls.indexOf(`--user start ${dashboard}`)).toBeLessThan(
				calls.indexOf(`start ${platform}`),
			);
		else
			expect(calls.indexOf(`start ${platform}`)).toBeLessThan(
				calls.indexOf(`--user start ${dashboard}`),
			);
		expect(calls.indexOf(`--user start ${gateway}`)).toBeGreaterThan(
			calls.indexOf(`--user start ${dashboard}`),
		);
		expect(existsSync(f.files.warm)).toBe(false);
		expect(() => waitForEgressSnapshot(f.paths, 100)).not.toThrow();
	},
);
