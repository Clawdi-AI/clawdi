import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeCommandShimScript } from "./manifest";
import type { RuntimePaths } from "./paths";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "clawdi-runtime-shim-"));
	tempDirs.push(dir);
	return dir;
}

function executable(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
}

function minimalPaths(serviceStateRoot: string, cliManagedBin: string): RuntimePaths {
	return {
		mode: "hosted",
		userHome: "/tmp/clawdi-user",
		clawdiHome: "/tmp/clawdi-home",
		localConfig: "/tmp/clawdi-home/config.json",
		localAuth: "/tmp/clawdi-home/auth.json",
		localPendingAuth: "/tmp/clawdi-home/pending-auth.json",
		localEnvironments: "/tmp/clawdi-home/environments",
		serveState: "/tmp/clawdi-home/serve",
		imageShim: "/usr/local/bin/clawdi",
		hostPolicy: "/etc/clawdi/host-policy.json",
		runtimeSource: "/etc/clawdi/runtime-source.json",
		shareRoot: "/usr/share/clawdi",
		serviceStateRoot,
		managedConfig: join(serviceStateRoot, "config", "clawdi.json"),
		syncState: join(serviceStateRoot, "sync", "runtimes.json"),
		cliShim: "/usr/local/bin/clawdi",
		cliManagedBin,
		cliNpmPrefix: join(serviceStateRoot, "npm"),
		cliNpmCache: join(serviceStateRoot, "npm-cache"),
		cliBootstrapStatus: join(serviceStateRoot, "status", "cli-bootstrap.json"),
		providerHealthStatus: join(serviceStateRoot, "status", "provider-health.json"),
		cacheRoot: join(serviceStateRoot, "cache"),
		manifestLastGood: join(serviceStateRoot, "cache", "manifest.last-good.json"),
		manifestEtag: join(serviceStateRoot, "cache", "manifest.etag"),
		channelsEtag: join(serviceStateRoot, "cache", "channels.etag"),
		runConfigRoot: join(serviceStateRoot, "config", "run"),
		mitmProfileRoot: join(serviceStateRoot, "config", "mitm"),
		mitmProfileBundle: join(serviceStateRoot, "config", "mitm", "profiles.json"),
		supervisorRoot: join(serviceStateRoot, "supervisor"),
		supervisorConfig: join(serviceStateRoot, "supervisor", "supervisord.conf"),
		bootRoot: join(serviceStateRoot, "boot"),
		bootStatus: join(serviceStateRoot, "cache", "boot-status.json"),
		runtimeWatchStatus: join(serviceStateRoot, "status", "runtime-watch.json"),
		cloudStatus: join(serviceStateRoot, "boot", "status.json"),
		cloudResult: join(serviceStateRoot, "boot", "result.json"),
		instanceRoot: join(serviceStateRoot, "instances"),
		installInventory: join(serviceStateRoot, "install-inventory"),
		projectionRoot: join(serviceStateRoot, "config", "projections"),
		runRoot: join(serviceStateRoot, "run"),
		managedSecretRoot: join(serviceStateRoot, "run", "secrets"),
		managedSecretFile: join(serviceStateRoot, "run", "secrets", "runtime-secrets.json"),
		daemonAuthToken: join(serviceStateRoot, "run", "secrets", "auth-token"),
		instanceData: join(serviceStateRoot, "run", "instance-data.json"),
		sensitiveInstanceData: join(serviceStateRoot, "run", "instance-data-sensitive.json"),
		workspaceRoot: "/tmp/clawdi-user/clawdi",
	};
}

describe("runtime command shim", () => {
	it("lets OpenClaw's official update CLI bypass the runtime wrapper", () => {
		const root = makeTempDir();
		const shimDir = join(root, "service", "bin");
		const realBin = join(root, "real-bin");
		const logPath = join(root, "calls.log");
		mkdirSync(shimDir, { recursive: true });
		mkdirSync(realBin, { recursive: true });
		executable(join(realBin, "openclaw"), `#!/usr/bin/env sh\necho "openclaw:$*" >> ${logPath}\n`);
		executable(join(root, "clawdi"), `#!/usr/bin/env sh\necho "clawdi:$*" >> ${logPath}\n`);
		const shimPath = join(shimDir, "openclaw");
		writeFileSync(
			shimPath,
			runtimeCommandShimScript(minimalPaths(join(root, "service"), join(root, "clawdi"))),
			{ mode: 0o755 },
		);
		chmodSync(shimPath, 0o755);

		const env = { ...process.env, PATH: [shimDir, realBin, process.env.PATH ?? ""].join(":") };
		expect(spawnSync(shimPath, ["update", "--dry-run"], { env }).status).toBe(0);
		expect(spawnSync(shimPath, ["tui"], { env }).status).toBe(0);

		expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
			"openclaw:update --dry-run",
			"clawdi:run -- openclaw tui",
		]);
	});
});
