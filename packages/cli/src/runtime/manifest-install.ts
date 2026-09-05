import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeContentSha256 } from "./applied-state";
import { SYSTEM_CA_BUNDLE } from "./egress-env";
import type { RuntimeInstall, RuntimeManifest } from "./manifest-contract";
import type { RuntimePaths } from "./paths";
import { isSupportedRuntimeName } from "./run-config";
import {
	buildRuntimeUserCommand,
	clearTenantToolLocationOverrides,
	commandResolvable,
	executableExists,
	RuntimeUserCommandTimeoutError,
	spawnRuntimeUserCommand,
} from "./runtime-user-command";
import { writeRuntimePlatformFileAtomic } from "./state";

export interface RuntimeInstallObservation {
	runtime: string;
	enabled: boolean;
	status: "disabled" | "present" | "installed" | "configured" | "install_failed";
	executionUser: string | null;
	commandPath: string | null;
	appRoot: string | null;
	install: RuntimeInstall | null;
	installerUrl: string | null;
	executedInstallerUrl: string | null;
	exitCode: number | null;
	installStartedAt?: string;
	installFinishedAt?: string;
	installDurationMs?: number;
	error: string | null;
}
function runtimeInstallObservation(
	observation: Pick<RuntimeInstallObservation, "runtime" | "enabled" | "status"> &
		Partial<Omit<RuntimeInstallObservation, "runtime" | "enabled" | "status">>,
): RuntimeInstallObservation {
	return {
		executionUser: null,
		commandPath: null,
		appRoot: null,
		install: null,
		installerUrl: null,
		executedInstallerUrl: null,
		exitCode: null,
		error: null,
		...observation,
	};
}
export function runtimeCommandPath(name: string, home: string): string | null {
	if (name === "openclaw") return join(home, ".local", "bin", "openclaw");
	if (name === "hermes") return join(home, ".local", "bin", "hermes");
	return null;
}
export function runtimeAppRoot(name: string, home: string): string | null {
	if (name === "openclaw") return join(home, ".openclaw");
	if (name === "hermes") return join(home, ".hermes", "hermes-agent");
	return null;
}
const HERMES_DASHBOARD_CAPABILITY_PROBE =
	"import uvicorn; assert callable(getattr(uvicorn.Server, 'capture_signals', None))";
const HERMES_DASHBOARD_CAPABILITY_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const runtimeCommandRevisions = new Map<
	string,
	{ executableRevision: string; commandRevision: string; version: string }
>();
function runtimeInstallTimeoutMs(): number {
	const raw = process.env.CLAWDI_RUNTIME_INSTALL_TIMEOUT;
	if (raw === undefined) return DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS;
	const timeout = Number(raw);
	if (Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 0x7fffffff) return timeout;
	console.warn(
		`CLAWDI_RUNTIME_INSTALL_TIMEOUT must be a valid positive integer; using ${DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS}ms`,
	);
	return DEFAULT_RUNTIME_INSTALL_TIMEOUT_MS;
}
function hermesDashboardCapabilityError(
	name: string,
	runtime: RuntimeManifest["runtimes"][string],
): string | null {
	if (name !== "hermes" || !runtime.enabled || !runtime.install || !runtime.services?.dashboard)
		return null;
	const python = join(runtime.install.home, ".hermes", "hermes-agent", "venv", "bin", "python");
	if (!executableExists(python)) {
		return `Hermes dashboard runtime is missing its managed Python interpreter: ${python}`;
	}
	let result: ReturnType<typeof spawnRuntimeUserCommand>;
	try {
		result = spawnRuntimeUserCommand(
			python,
			["-c", HERMES_DASHBOARD_CAPABILITY_PROBE],
			runtime.install.home,
			runtime.install.home,
			{ timeoutMs: HERMES_DASHBOARD_CAPABILITY_PROBE_TIMEOUT_MS },
		);
	} catch (error) {
		return `Hermes dashboard runtime capability probe failed: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
	if (result.status === 0) {
		return null;
	}
	return `Hermes dashboard runtime is incompatible: ${
		tail(String(result.stderr ?? "")) ??
		(result.error instanceof Error
			? result.error.message
			: "uvicorn.Server.capture_signals is unavailable")
	}`;
}
function runtimeInstallerExecution(
	runtime: string,
	install: RuntimeInstall,
	installerPath: string,
	identity: { uid: number; gid: number },
	extraArgs: string[] = [],
): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	executionUser: string | null;
} {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	const env = runtimeInstallerEnv(runtime, install);
	if (!runtimeUser || runtimeUser === "root") {
		return {
			command: "bash",
			args: [installerPath, ...install.args, ...extraArgs],
			env,
			executionUser: null,
		};
	}

	const child = buildRuntimeUserCommand(
		runtimeUser,
		install.home,
		"bash",
		[installerPath, ...install.args, ...extraArgs],
		{ runtimeUid: identity.uid, runtimeGid: identity.gid },
	);
	return {
		command: child.command,
		args: child.args,
		env: { ...env, ...child.env },
		executionUser: runtimeUser,
	};
}
function runtimeInstallerEnv(runtime: string, install: RuntimeInstall): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: install.home,
		PATH: [join(install.home, ".local", "bin"), process.env.PATH].filter(Boolean).join(":"),
	};
	clearTenantToolLocationOverrides(env);
	if (runtime === "openclaw") {
		for (const key of [
			"OPENCLAW_HOME",
			"OPENCLAW_STATE_DIR",
			"OPENCLAW_CONFIG_PATH",
			"OPENCLAW_PREFIX",
			"OPENCLAW_VERSION",
			"OPENCLAW_INSTALL_METHOD",
			"OPENCLAW_GIT_DIR",
			"OPENCLAW_GIT_UPDATE",
		] as const) {
			delete env[key];
		}
	}
	env.SSL_CERT_FILE = SYSTEM_CA_BUNDLE;
	env.NODE_EXTRA_CA_CERTS = SYSTEM_CA_BUNDLE;
	env.REQUESTS_CA_BUNDLE = SYSTEM_CA_BUNDLE;
	env.CURL_CA_BUNDLE = SYSTEM_CA_BUNDLE;
	env.GIT_SSL_CAINFO = SYSTEM_CA_BUNDLE;
	env.NPM_CONFIG_CAFILE = SYSTEM_CA_BUNDLE;
	env.npm_config_cafile = SYSTEM_CA_BUNDLE;
	return env;
}
export function tail(value: string | null | undefined): string | null {
	if (!value) return null;
	return value.slice(-4000);
}
function testInstallerEnvName(name: string): string | null {
	if (name === "openclaw") return "CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER";
	if (name === "hermes") return "CLAWDI_RUNTIME_TEST_HERMES_INSTALLER";
	return null;
}
function executionInstallerUrl(name: string, officialUrl: string): string {
	const envName = testInstallerEnvName(name);
	const override = envName ? process.env[envName]?.trim() : undefined;
	if (override) {
		if (process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1") {
			throw new Error(`${envName} requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1`);
		}
		return override;
	}
	return officialUrl;
}
function materializeInstaller(
	name: string,
	installerUrl: string,
	paths: RuntimePaths,
): { path: string; cleanup?: string } {
	if (installerUrl.startsWith("file://")) {
		return { path: fileURLToPath(installerUrl) };
	}
	if (installerUrl.startsWith("/")) {
		return { path: installerUrl };
	}
	if (!installerUrl.startsWith("https://")) {
		throw new Error(`runtime ${name} installer must use https:// or a test file URL`);
	}
	const dir = mkdtempSync(join(tmpdir(), `clawdi-${name}-installer-`));
	chmodSync(dir, 0o755);
	const path = join(dir, "install.sh");
	const curl = spawnSync(
		"curl",
		["-fsSL", "--proto", "=https", "--tlsv1.2", "--retry", "3", "-o", path, installerUrl],
		{ encoding: "utf8" },
	);
	if (curl.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		const logPath = writeRuntimeInstallerLog(paths, `${name}-download`, curl);
		throw new Error(`could not download ${name} official installer; see ${logPath}`);
	}
	chmodSync(path, 0o755);
	return { path, cleanup: dir };
}
function runOfficialInstaller(
	name: string,
	install: RuntimeInstall,
	paths: RuntimePaths,
	identity: { uid: number; gid: number },
): RuntimeInstallObservation {
	const installStartedAt = new Date().toISOString();
	const installStartedMs = Date.now();
	const finish = (observation: RuntimeInstallObservation): RuntimeInstallObservation => ({
		...observation,
		installStartedAt,
		installFinishedAt: new Date().toISOString(),
		installDurationMs: Math.max(0, Date.now() - installStartedMs),
	});
	const commandPath = runtimeCommandPath(name, install.home);
	const appRoot = runtimeAppRoot(name, install.home);
	if (!commandPath || !appRoot) {
		return finish(
			runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: "install_failed",
				commandPath,
				appRoot,
				install,
				installerUrl: install.url,
				error: `unsupported runtime ${name}`,
			}),
		);
	}
	if (executableExists(commandPath)) {
		return finish(
			runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: "present",
				commandPath,
				appRoot,
				install,
				installerUrl: install.url,
			}),
		);
	}

	const url = executionInstallerUrl(name, install.url);
	const materialized = materializeInstaller(name, url, paths);
	try {
		const execution = runtimeInstallerExecution(name, install, materialized.path, identity);
		const result = spawnSync(execution.command, execution.args, {
			cwd: install.home,
			env: execution.env,
			encoding: "utf8",
			timeout: runtimeInstallTimeoutMs(),
		});
		const logPath = writeRuntimeInstallerLog(paths, name, result);
		const exitCode = result.status ?? 1;
		const installed = exitCode === 0 && executableExists(commandPath);
		return finish(
			runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: installed ? "installed" : "install_failed",
				executionUser: execution.executionUser,
				commandPath,
				appRoot,
				install,
				installerUrl: install.url,
				executedInstallerUrl: url === install.url ? install.url : url,
				exitCode,
				error: installed
					? null
					: `runtime ${name} installer failed or did not create ${commandPath}; see ${logPath}`,
			}),
		);
	} catch (error) {
		const logPath = writeRuntimeInstallerLog(paths, name, { error });
		return finish(
			runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: "install_failed",
				commandPath,
				appRoot,
				install,
				installerUrl: install.url,
				executedInstallerUrl: url,
				error: `runtime ${name} installer failed; see ${logPath}`,
			}),
		);
	} finally {
		if (materialized.cleanup) rmSync(materialized.cleanup, { recursive: true, force: true });
	}
}
export function observeRuntimeInstall(
	name: string,
	runtime: RuntimeManifest["runtimes"][string],
	home: string,
	paths: RuntimePaths,
	identity: { uid: number; gid: number },
) {
	if (!runtime.enabled) {
		return runtimeInstallObservation({
			runtime: name,
			enabled: false,
			status: "disabled",
			install: runtime.install ?? null,
			installerUrl: runtime.install?.url ?? null,
		});
	}
	if (!runtime.install) {
		if (runtime.run?.command?.trim() || isSupportedRuntimeName(name)) {
			const configuredCommand = runtime.run?.command?.trim() || null;
			const commandPath =
				isSupportedRuntimeName(name) && configuredCommand && commandResolvable(configuredCommand)
					? configuredCommand
					: null;
			return runtimeInstallObservation({
				runtime: name,
				enabled: true,
				status: "configured",
				commandPath,
				appRoot: commandPath ? runtimeAppRoot(name, home) : null,
			});
		}
		return runtimeInstallObservation({
			runtime: name,
			enabled: true,
			status: "install_failed",
			error: `runtime ${name} is enabled but missing install metadata`,
		});
	}
	const observation = runOfficialInstaller(name, runtime.install, paths, identity);
	if (observation.error) return observation;
	const capabilityError = hermesDashboardCapabilityError(name, runtime);
	return capabilityError
		? { ...observation, status: "install_failed" as const, error: capabilityError }
		: observation;
}
export function planRuntimeInstallObservation(
	name: string,
	runtime: RuntimeManifest["runtimes"][string],
	home: string,
	paths: RuntimePaths,
	identity: { uid: number; gid: number },
): RuntimeInstallObservation {
	if (!runtime.install) return observeRuntimeInstall(name, runtime, home, paths, identity);
	if (!runtime.enabled) return observeRuntimeInstall(name, runtime, home, paths, identity);
	const commandPath = runtimeCommandPath(name, runtime.install.home);
	const appRoot = runtimeAppRoot(name, runtime.install.home);
	return runtimeInstallObservation({
		runtime: name,
		enabled: true,
		status: commandPath && executableExists(commandPath) ? "present" : "configured",
		commandPath,
		appRoot,
		install: runtime.install,
		installerUrl: runtime.install.url,
		error: commandPath && appRoot ? null : `unsupported runtime ${name}`,
	});
}

export function writeRuntimeInstallerLog(
	paths: RuntimePaths,
	name: string,
	result: {
		status?: number | null;
		signal?: NodeJS.Signals | null;
		stdout?: string | Buffer | null;
		stderr?: string | Buffer | null;
		error?: unknown;
	},
): string {
	const path = join(paths.statusRoot, "installer-logs", `${name}.log`);
	const error = result.error
		? result.error instanceof Error
			? result.error.message
			: String(result.error)
		: "";
	const contents = [
		`recordedAt=${new Date().toISOString()}`,
		`exitCode=${result.status ?? "unavailable"}`,
		`signal=${result.signal ?? "none"}`,
		`spawnError=${error}`,
		"--- stdout ---",
		String(result.stdout ?? ""),
		"--- stderr ---",
		String(result.stderr ?? ""),
		"",
	].join("\n");
	const options = { mode: 0o600, dirMode: 0o700 };
	// Keep one failure per installer even when recovery overwrites the latest attempt.
	if (result.status !== 0 || result.signal || result.error) {
		writeRuntimePlatformFileAtomic(
			paths,
			join(paths.statusRoot, "installer-logs", `${name}.failed.log`),
			contents,
			options,
		);
	}
	writeRuntimePlatformFileAtomic(paths, path, contents, options);
	return path;
}
export function runtimeFileCurrentRevision(path: string): string | null {
	if (!isAbsolute(path)) return null;
	try {
		const linkStat = lstatSync(path);
		if (!linkStat.isFile() && !linkStat.isSymbolicLink()) return null;
		const fileStat = linkStat.isSymbolicLink() ? statSync(path) : linkStat;
		if (!fileStat.isFile()) return null;
		const contents = readFileSync(path);
		return runtimeContentSha256({
			path,
			contentsSha256: createHash("sha256").update(contents).digest("hex"),
			kind: linkStat.isSymbolicLink() ? "symlink" : "file",
			linkTarget: linkStat.isSymbolicLink() ? readlinkSync(path) : null,
			linkUid: linkStat.uid,
			linkGid: linkStat.gid,
			fileMode: fileStat.mode & 0o7777,
			fileUid: fileStat.uid,
			fileGid: fileStat.gid,
		});
	} catch {
		return null;
	}
}
export function runtimeCommandCurrentRevision(
	command: string,
	home: string,
	cwd: string,
): string | null {
	const executableRevision = runtimeFileCurrentRevision(command);
	if (!executableRevision) return null;
	const cacheKey = `${command}\0${home}\0${cwd}`;
	const cached = runtimeCommandRevisions.get(cacheKey);
	if (cached?.executableRevision === executableRevision) return cached.commandRevision;
	if (!runtimeCommandVersion(command, home, cwd)) return null;
	return runtimeCommandRevisions.get(cacheKey)?.commandRevision ?? null;
}
export function runtimeCommandVersion(command: string, home: string, cwd: string): string | null {
	const executableRevision = runtimeFileCurrentRevision(command);
	if (!executableRevision) return null;
	const cacheKey = `${command}\0${home}\0${cwd}`;
	const cached = runtimeCommandRevisions.get(cacheKey);
	if (cached?.executableRevision === executableRevision) return cached.version;
	try {
		const versionResult = spawnRuntimeUserCommand(command, ["--version"], home, cwd, {
			timeoutMs: 10_000,
		});
		if (
			versionResult.error &&
			"code" in versionResult.error &&
			versionResult.error.code === "ETIMEDOUT"
		) {
			throw new RuntimeUserCommandTimeoutError(`runtime --version probe for ${command}`, 10_000);
		}
		if (versionResult.status !== 0) return null;
		const stdout = Buffer.isBuffer(versionResult.stdout)
			? versionResult.stdout.toString("utf8")
			: versionResult.stdout;
		const stderr = Buffer.isBuffer(versionResult.stderr)
			? versionResult.stderr.toString("utf8")
			: versionResult.stderr;
		const version = [stdout, stderr].filter(Boolean).join("\n").trim();
		if (!version) return null;
		const commandRevision = runtimeContentSha256({
			executableRevision,
			version,
		});
		runtimeCommandRevisions.set(cacheKey, { executableRevision, commandRevision, version });
		return version;
	} catch (error) {
		if (error instanceof RuntimeUserCommandTimeoutError) throw error;
		return null;
	}
}
