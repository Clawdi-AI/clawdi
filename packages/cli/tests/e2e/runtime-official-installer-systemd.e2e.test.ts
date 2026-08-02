import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convergeRuntimeManifest } from "../../src/runtime/manifest";
import type { RuntimeManifest } from "../../src/runtime/manifest-contract";
import type { RuntimeManifestLoad } from "../../src/runtime/manifest-source";
import { getRuntimePaths } from "../../src/runtime/paths";

const REAL_SYSTEMD_GATE = "CLAWDI_TEST_REAL_OPENCLAW_SYSTEMD";

test("propagates the real official OpenClaw installer failure and rolls back as UID 10001", () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const runtimeHome = "/home/clawdi";
	const runtimeUid = 10_001;
	const runtimeGid = 10_001;
	const commandPath = join(runtimeHome, ".openclaw", "bin", "openclaw");
	const expectedVersion = process.env.CLAWDI_TEST_OPENCLAW_VERSION ?? "";
	const expectedCommit = process.env.CLAWDI_TEST_OPENCLAW_COMMIT ?? "";
	const version = spawnSync(commandPath, ["--version"], {
		encoding: "utf8",
		env: { ...process.env, HOME: runtimeHome },
	});
	expect(version.status).toBe(0);
	expect(version.stdout).toContain(`OpenClaw ${expectedVersion}`);
	expect(version.stdout).toContain(`(${expectedCommit.slice(0, 7)})`);

	const userManager = spawnSync("systemctl", ["is-active", `user@${runtimeUid}.service`], {
		encoding: "utf8",
	});
	expect(userManager.status).toBe(0);
	expect(userManager.stdout.trim()).toBe("active");
	expect(statSync(`/run/user/${runtimeUid}/bus`).isSocket()).toBe(true);
	const userSystemd = spawnSync(
		"runuser",
		[
			"-u",
			"clawdi",
			"--",
			"env",
			`HOME=${runtimeHome}`,
			`XDG_RUNTIME_DIR=/run/user/${runtimeUid}`,
			`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${runtimeUid}/bus`,
			"systemctl",
			"--user",
			"show-environment",
		],
		{ encoding: "utf8" },
	);
	expect(userSystemd.status).toBe(0);

	const root = mkdtempSync(join(tmpdir(), "clawdi-real-openclaw-systemd-"));
	chmodSync(root, 0o755);
	const clawdiHome = join(root, "clawdi-home");
	mkdirSync(clawdiHome);
	chownSync(clawdiHome, runtimeUid, runtimeGid);
	chmodSync(clawdiHome, 0o700);
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = "clawdi";
	process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
	process.env.CLAWDI_RUNTIME_HOME = runtimeHome;
	process.env.CLAWDI_HOME = clawdiHome;
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
	process.env.CLAWDI_AUTH_TOKEN = "real-systemd-test-auth-token";
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	const paths = getRuntimePaths({ mode: "hosted" });
	const unitPath = join(paths.systemdUserRoot, "openclaw-gateway.service");
	const unitSentinel = join(unitPath, "preserved-before-install");
	const dropInPath = join(
		paths.systemdUserRoot,
		"openclaw-gateway.service.d",
		"10-clawdi-hosted.conf",
	);
	const enablementPath = join(
		paths.systemdUserRoot,
		"default.target.wants",
		"openclaw-gateway.service",
	);
	const openClawConfig = join(runtimeHome, ".openclaw", "openclaw.json");
	const gatewayEnvironment = join(runtimeHome, ".openclaw", "gateway.systemd.env");
	expect(existsSync(unitPath)).toBe(false);
	expect(existsSync(openClawConfig)).toBe(false);
	expect(existsSync(gatewayEnvironment)).toBe(false);
	const previousOpenClawConfig = '{"gateway":{"mode":"local"}}\n';
	const previousGatewayEnvironment = "PRESERVED_ENV=before\n";
	writeFileSync(openClawConfig, previousOpenClawConfig, { mode: 0o600 });
	writeFileSync(gatewayEnvironment, previousGatewayEnvironment, { mode: 0o600 });
	mkdirSync(dirname(unitPath), { recursive: true });
	mkdirSync(unitPath, { recursive: false });
	writeFileSync(unitSentinel, "preserve exact rollback target\n");

	const workspaceRoot = join(runtimeHome, "clawdi-systemd-test-workspace");
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_real_openclaw_systemd",
		environmentId: "env_real_openclaw_systemd",
		instanceId: "hri_real_openclaw_systemd",
		generation: 1,
		issuedAt: "2026-08-02T00:00:00.000Z",
		workspaceRoot,
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: {
			openclaw: {
				enabled: true,
				run: { command: commandPath, args: ["gateway", "run"], env: {}, prependPath: [] },
				services: {},
			},
		},
		recovery: {},
	};
	const load: RuntimeManifestLoad = {
		manifest,
		source: "remote-datasource",
		sourcePath: "real-openclaw-systemd-fixture",
		offline: false,
		applyContext: {
			kind: "context-file",
			identity: {
				generation: manifest.generation,
				manifestETag: '"real-systemd-test"',
				applyReceiptId: "real-systemd-test-receipt",
				bootNonce: "real-systemd-test-boot",
			},
			cliPackageSpec: "clawdi@0.13.30",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_real_openclaw_systemd",
				auth: { type: "bearer", token: "real-systemd-test-auth-token" },
			},
		},
	};
	let authorityCommits = 0;
	const result = convergeRuntimeManifest(load, paths, {
		executeOfficialServiceInstallers: true,
		cacheLastGood: false,
		commitAuthority: () => {
			authorityCommits += 1;
		},
	});
	const detail = result.installErrors.join("\n");
	expect(detail).toContain("official openclaw-gateway service install failed");
	expect(detail).toContain("exit code 1");
	expect(detail).toContain("stdout tail:");
	expect(detail).toContain("Gateway install failed:");
	expect(detail).toContain("EISDIR");
	expect(detail).not.toContain("stderr tail:");
	expect(detail.length).toBeLessThan(5000);
	expect(authorityCommits).toBe(0);
	expect(statSync(unitPath).isDirectory()).toBe(true);
	expect(readFileSync(unitSentinel, "utf8")).toBe("preserve exact rollback target\n");
	expect(readFileSync(openClawConfig, "utf8")).toBe(previousOpenClawConfig);
	expect(readFileSync(gatewayEnvironment, "utf8")).toBe(previousGatewayEnvironment);
	for (const path of [unitPath, openClawConfig, gatewayEnvironment]) {
		const stat = statSync(path);
		expect(stat.uid).toBe(0);
		expect(stat.gid).toBe(0);
	}
	expect(statSync(openClawConfig).mode & 0o777).toBe(0o600);
	expect(statSync(gatewayEnvironment).mode & 0o777).toBe(0o600);
	for (const path of [
		`${unitPath}.bak`,
		dropInPath,
		enablementPath,
		paths.managedConfig,
		paths.manifestLastGood,
	]) {
		expect(existsSync(path)).toBe(false);
	}
	expect(existsSync(workspaceRoot)).toBe(false);
});
