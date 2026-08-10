import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
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
import {
	applySystemdRuntimeUpdate,
	quiesceSystemdRuntimeCandidate,
	readSystemdUnitSnapshot,
} from "../../src/commands/runtime";
import { convergeRuntimeManifest } from "../../src/runtime/manifest";
import {
	FILE_BROWSER_AMD64_SHA256,
	FILE_BROWSER_ARM64_SHA256,
	FILE_BROWSER_COMMIT,
	FILE_BROWSER_VERSION,
	type RuntimeManifest,
} from "../../src/runtime/manifest-contract";
import type { RuntimeManifestLoad } from "../../src/runtime/manifest-source";
import { getRuntimePaths } from "../../src/runtime/paths";
import { ensureRuntimeStateDirs } from "../../src/runtime/state";

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
	ensureRuntimeStateDirs(paths);
	rmSync(join(paths.systemdUserRoot, "openclaw-gateway.service"), {
		recursive: true,
		force: true,
	});
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
			backend: "incus",
			identity: {
				generation: manifest.generation,
				manifestETag: '"real-systemd-test"',
				applyReceiptId: "real-systemd-test-receipt",
				bootNonce: "real-systemd-test-boot",
			},
			cliPackageSpec: "clawdi@1.2.3",
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

test("isolates File Browser from the tenant while preserving workspace access", () => {
	if (process.env[REAL_SYSTEMD_GATE] !== "1") return;

	expect(process.geteuid?.()).toBe(0);
	const runtimeHome = "/home/clawdi";
	const runtimeUid = 10_001;
	const runtimeGid = 10_001;
	const root = mkdtempSync("/var/lib/clawdi-real-filebrowser-systemd-");
	chmodSync(root, 0o755);
	const clawdiHome = join(root, "clawdi-home");
	mkdirSync(clawdiHome);
	chownSync(clawdiHome, runtimeUid, runtimeGid);
	chmodSync(clawdiHome, 0o700);
	const tenantExisting = join(runtimeHome, "files-tenant-existing.txt");
	writeFileSync(tenantExisting, "tenant-existing\n", { mode: 0o600 });
	chownSync(tenantExisting, runtimeUid, runtimeGid);

	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = "clawdi";
	process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
	process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);
	process.env.CLAWDI_RUNTIME_HOME = runtimeHome;
	process.env.CLAWDI_HOME = clawdiHome;
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = "/run/systemd/system";
	process.env.CLAWDI_AUTH_TOKEN = "real-filebrowser-systemd-test-auth-token";
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	rmSync(join(paths.systemdUserRoot, "openclaw-gateway.service"), {
		recursive: true,
		force: true,
	});
	const serviceCreated = join(runtimeHome, "files-service-created.txt");
	const tenantCreated = join(runtimeHome, "files-tenant-created.txt");
	const binary = `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '%s\n' '${FILE_BROWSER_VERSION} ${FILE_BROWSER_COMMIT.slice(0, 7)}'
  exit 0
fi
exec /usr/local/bin/node -e '
const fs = require("fs");
const http = require("http");
const existing = fs.readFileSync(${JSON.stringify(tenantExisting)}, "utf8");
fs.writeFileSync(${JSON.stringify(serviceCreated)}, existing);
fs.mkdirSync(${JSON.stringify(join(paths.fileBrowserStateRoot, "cache"))});
fs.writeFileSync(${JSON.stringify(join(paths.fileBrowserStateRoot, "filebrowser.db"))}, "service-state\\n");
http.createServer((request, response) => {
  if (request.url === "/read-new") {
    response.end(fs.readFileSync(${JSON.stringify(tenantCreated)}, "utf8"));
    return;
  }
  response.end("ok");
}).listen(9120, "0.0.0.0");
'
`;
	const binarySha256 = createHash("sha256").update(binary).digest("hex");
	const release = `https://github.com/gtsteffaniak/filebrowser/releases/download/${FILE_BROWSER_VERSION}`;
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_real_filebrowser_systemd",
		environmentId: "env_real_filebrowser_systemd",
		instanceId: "hri_real_filebrowser_systemd",
		generation: 1,
		issuedAt: "2026-08-06T00:00:00.000Z",
		workspaceRoot: runtimeHome,
		projection: { sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2" },
		openclawGatewayAuth: {
			mode: "token",
			tokenRef: "secret://runtime/openclaw/gateway-token",
			deviceAuthRequired: false,
			activation: { enabled: true, capability: "openclaw-native-auth-v1" },
		},
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		companions: {
			filebrowser: {
				version: FILE_BROWSER_VERSION,
				commit: FILE_BROWSER_COMMIT,
				listen: "0.0.0.0",
				port: 9120,
				baseURL: "/",
				healthPath: "/health",
				sourceRoot: runtimeHome,
				assets: {
					amd64: {
						url: `${release}/linux-amd64-filebrowser`,
						sha256: FILE_BROWSER_AMD64_SHA256,
					},
					arm64: {
						url: `${release}/linux-arm64-filebrowser`,
						sha256: FILE_BROWSER_ARM64_SHA256,
					},
				},
				auth: {
					method: "jwt",
					algorithm: "HS256",
					header: "X-JWT-Assertion",
					userIdentifier: "sub",
					groupsClaim: "groups",
					secret: "s".repeat(43),
					audience: "clawdi-files:hdep_real_filebrowser_systemd",
					subject: "deployment:hdep_real_filebrowser_systemd:owner",
					requiredGroup: `clawdi-files:hdep_real_filebrowser_systemd:${"a".repeat(64)}`,
					accessRevision: "a".repeat(64),
				},
			},
		},
		runtimes: {
			openclaw: {
				enabled: false,
				run: { command: "openclaw", args: [], env: {}, prependPath: [] },
				services: {},
			},
		},
		recovery: {},
	};
	// The production digest remains schema-pinned; this isolated executable is
	// injected only after constructing the already typed fixture.
	Reflect.set(manifest.companions?.filebrowser?.assets.amd64 ?? {}, "sha256", binarySha256);
	const load: RuntimeManifestLoad = {
		manifest,
		source: "remote-datasource",
		sourcePath: "real-filebrowser-systemd-fixture",
		offline: false,
		secretValues: { "secret://runtime/openclaw/gateway-token": "fixture-gateway-token" },
		applyContext: {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: manifest.generation,
				manifestETag: '"real-filebrowser-systemd-test"',
				applyReceiptId: "real-filebrowser-systemd-test-receipt",
				bootNonce: "real-filebrowser-systemd-test-boot",
			},
			cliPackageSpec: "clawdi@1.2.3",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_real_filebrowser_systemd",
				auth: { type: "bearer", token: "real-filebrowser-systemd-test-auth-token" },
			},
		},
	};
	const before = readSystemdUnitSnapshot(paths);
	let failed = before;
	const result = convergeRuntimeManifest(load, paths, {
		fileBrowserInstallOptions: {
			download: (_url, destination) => writeFileSync(destination, binary),
		},
		systemdApply: {
			quiesce: () => {
				failed = readSystemdUnitSnapshot(paths);
				quiesceSystemdRuntimeCandidate(paths, failed);
			},
			activateEgressPrerequisite: () => ({
				applied: true,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			}),
			activate: () => {
				failed = readSystemdUnitSnapshot(paths);
				return applySystemdRuntimeUpdate(paths, before, failed);
			},
			rollback: () => {
				applySystemdRuntimeUpdate(paths, failed, readSystemdUnitSnapshot(paths), {
					recoverFailedUnits: false,
				});
			},
		},
	});
	expect(result.installErrors).toEqual([]);

	const serviceIdentity = spawnSync("getent", ["passwd", "clawdi-files"], {
		encoding: "utf8",
	});
	expect(serviceIdentity.status).toBe(0);
	const serviceFields = serviceIdentity.stdout.trim().split(":");
	const serviceUid = Number.parseInt(serviceFields[2] ?? "", 10);
	const serviceGid = Number.parseInt(serviceFields[3] ?? "", 10);
	expect(serviceUid).not.toBe(runtimeUid);
	expect(serviceUid).not.toBe(0);
	expect(serviceGid).not.toBe(runtimeGid);
	expect(serviceFields[5]).toBe("/nonexistent");
	expect(serviceFields[6]).toBe("/usr/sbin/nologin");
	const tenantGroups = spawnSync("id", ["-G", "clawdi"], { encoding: "utf8" });
	expect(tenantGroups.status).toBe(0);
	expect(tenantGroups.stdout.trim().split(/\s+/)).not.toContain(String(serviceGid));
	const serviceGroups = spawnSync("id", ["-G", "clawdi-files"], { encoding: "utf8" });
	expect(serviceGroups.status).toBe(0);
	expect(serviceGroups.stdout.trim().split(/\s+/)).toEqual([String(serviceGid)]);

	const candidatesRoot = join(paths.fileBrowserInstallRoot, "candidates");
	const activeCandidate = join(candidatesRoot, binarySha256);
	const activeBinary = join(activeCandidate, "filebrowser");
	const receipt = paths.installReceipts;
	for (const path of [
		paths.fileBrowserInstallRoot,
		candidatesRoot,
		activeCandidate,
		activeBinary,
		receipt,
		paths.manifestLastGood,
	]) {
		expect(statSync(path).uid).toBe(0);
		expect(statSync(path).gid).toBe(0);
	}
	expect(statSync(paths.fileBrowserConfig).uid).toBe(0);
	expect(statSync(paths.fileBrowserConfig).gid).toBe(0);
	expect(statSync(paths.fileBrowserConfig).mode & 0o777).toBe(0o600);
	expect(statSync(paths.fileBrowserStateRoot).uid).toBe(serviceUid);
	expect(statSync(paths.fileBrowserStateRoot).gid).toBe(serviceGid);
	expect(statSync(paths.fileBrowserStateRoot).mode & 0o777).toBe(0o700);
	expect(statSync(receipt).mode & 0o777).toBe(0o600);
	expect(statSync(paths.manifestLastGood).mode & 0o777).toBe(0o600);
	expect(readFileSync(paths.manifestLastGood, "utf8")).toContain(`"secret": "${"s".repeat(43)}"`);
	const cache = join(paths.fileBrowserStateRoot, "cache");
	const database = join(paths.fileBrowserStateRoot, "filebrowser.db");
	for (const path of [cache, database]) {
		expect(statSync(path).uid).toBe(serviceUid);
		expect(statSync(path).gid).toBe(serviceGid);
	}
	expect(statSync(cache).mode & 0o777).toBe(0o700);
	expect(statSync(database).mode & 0o777).toBe(0o600);

	for (const path of [
		paths.fileBrowserConfig,
		paths.fileBrowserStateRoot,
		database,
		receipt,
		paths.manifestLastGood,
	]) {
		const denied = spawnSync("runuser", ["-u", "clawdi", "--", "test", "!", "-r", path]);
		expect(denied.status).toBe(0);
	}
	for (const path of [
		paths.fileBrowserInstallRoot,
		candidatesRoot,
		activeCandidate,
		activeBinary,
		paths.fileBrowserConfig,
		paths.fileBrowserStateRoot,
		database,
		receipt,
		paths.manifestLastGood,
		join(paths.systemdSystemRoot, "clawdi-files.service"),
	]) {
		const denied = spawnSync("runuser", ["-u", "clawdi", "--", "test", "!", "-w", path]);
		expect(denied.status).toBe(0);
	}
	const overwrite = spawnSync("runuser", [
		"-u",
		"clawdi",
		"--",
		"sh",
		"-c",
		'printf tamper > "$1"',
		"sh",
		activeBinary,
	]);
	expect(overwrite.status).not.toBe(0);

	const mainPidResult = spawnSync(
		"systemctl",
		["show", "clawdi-files.service", "--property=MainPID", "--value"],
		{ encoding: "utf8" },
	);
	expect(mainPidResult.status).toBe(0);
	const mainPid = Number.parseInt(mainPidResult.stdout.trim(), 10);
	expect(mainPid).toBeGreaterThan(1);
	expect(statSync(`/proc/${mainPid}`).uid).toBe(serviceUid);
	const signal = spawnSync("runuser", ["-u", "clawdi", "--", "kill", "-TERM", String(mainPid)]);
	expect(signal.status).not.toBe(0);
	const unitControl = spawnSync(
		"runuser",
		["-u", "clawdi", "--", "systemctl", "stop", "clawdi-files.service"],
		{ timeout: 5000 },
	);
	expect(unitControl.status).not.toBe(0);
	expect(spawnSync("systemctl", ["is-active", "--quiet", "clawdi-files.service"]).status).toBe(0);

	let readinessStatus: number | null = null;
	for (let attempt = 0; attempt < 50; attempt++) {
		readinessStatus = spawnSync("curl", ["-fsS", "http://127.0.0.1:9120/health"]).status;
		if (readinessStatus === 0) break;
		spawnSync("sleep", ["0.1"]);
	}
	expect(readinessStatus).toBe(0);

	const tenantWrite = spawnSync("runuser", [
		"-u",
		"clawdi",
		"--",
		"sh",
		"-c",
		'umask 077; printf "tenant-created\\n" > "$1"',
		"sh",
		tenantCreated,
	]);
	expect(tenantWrite.status).toBe(0);
	const serviceRead = spawnSync("curl", ["-fsS", "http://127.0.0.1:9120/read-new"], {
		encoding: "utf8",
	});
	expect(serviceRead.status).toBe(0);
	expect(serviceRead.stdout).toBe("tenant-created\n");
	const tenantRead = spawnSync("runuser", ["-u", "clawdi", "--", "cat", serviceCreated], {
		encoding: "utf8",
	});
	expect(tenantRead.status).toBe(0);
	expect(tenantRead.stdout).toBe("tenant-existing\n");
});
