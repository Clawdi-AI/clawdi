import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chownSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import { writePrivateFileAtomic } from "../lib/private-file";
import { applyRuntimeCliDesiredState } from "./cli-update";
import { prepareHermesDashboardBuild } from "./hermes-dashboard-build";
import { resolveHostedOpenClawWorkspace } from "./hosted-openclaw-context";
import { ensureHostedCodexCli } from "./managed-codex-provider";
import { OFFICIAL_INSTALL_URLS, officialInstallArgs } from "./manifest-contract";
import {
	observeRuntimeInstall,
	runtimeCommandVersionRevision,
	runtimeFileCurrentRevision,
} from "./manifest-install";
import {
	prepareAnonymousOpenClawGateway,
	seedAnonymousOpenClawAuthProbes,
} from "./openclaw-preinstallation";
import { seedOpenClawMemorySearchLayout } from "./openclaw-provider-config";
import type { RuntimePaths } from "./paths";
import {
	flushPersistedStepRevisions,
	loadPersistedStepRevisions,
} from "./persisted-step-revisions";
import { type PreinstalledProbes, preinstalledSourceIdentity } from "./preinstalled-probes";
import { buildNumericUserCommand } from "./runtime-user-command";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const preinstallationSpecSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtime-preinstallation.v1"),
		imageFingerprint: sha256,
		architecture: z.enum(["x64", "arm64"]),
		cliPackageSpec: z.string().regex(/^clawdi@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
		runtime: z.enum(["openclaw", "hermes"]),
	})
	.strict();
export type PreinstallationSpec = z.infer<typeof preinstallationSpecSchema>;

const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export function anonymousInstallerEnvironment(home: string): Record<string, string> {
	return {
		HOME: home,
		USER: "clawdi",
		LOGNAME: "clawdi",
		PATH: `${home}/.local/bin:${SYSTEM_PATH}`,
		CI: "1",
		TERM: "dumb",
		LANG: "C.UTF-8",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		NPM_CONFIG_USERCONFIG: "/dev/null",
		NPM_CONFIG_GLOBALCONFIG: `${home}/.cache/anonymous-npm-globalrc`,
		NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
		NPM_CONFIG_CACHE: `${home}/.cache/npm`,
		UV_NO_CONFIG: "1",
		UV_CACHE_DIR: `${home}/.cache/uv`,
		XDG_CONFIG_HOME: `${home}/.config`,
		XDG_CACHE_HOME: `${home}/.cache`,
		PIP_CONFIG_FILE: "/dev/null",
		PYTHONNOUSERSITE: "1",
	};
}

/** Include paths, modes, contents and link targets; never follow links outside the tree. */
export function preinstallationTreeSha256(root: string): string {
	const digest = createHash("sha256");
	function visit(relative: string) {
		const path = join(root, relative);
		const stat = lstatSync(path);
		const kind = stat.isSymbolicLink()
			? "link"
			: stat.isDirectory()
				? "directory"
				: stat.isFile()
					? "file"
					: null;
		if (!kind) throw new Error("preinstallation contains a special file");
		digest.update(JSON.stringify([relative, kind, stat.mode & 0o7777, stat.uid, stat.gid]));
		if (kind === "link") digest.update(JSON.stringify(readlinkSync(path)));
		if (kind === "file")
			digest.update(createHash("sha256").update(readFileSync(path)).digest("hex"));
		if (kind === "directory")
			for (const name of readdirSync(path).sort()) visit(join(relative, name));
	}
	visit("");
	return digest.digest("hex");
}

function prepareOpenClawProbeResults(paths: RuntimePaths, command: string): void {
	loadPersistedStepRevisions(paths);
	resolveHostedOpenClawWorkspace(paths.userHome);
	const configMutation = resolveOpenClawSdkExport(
		paths.userHome,
		[command],
		OPENCLAW_SDK_EXPORT_PATHS.configMutation,
	);
	if (configMutation) seedOpenClawMemorySearchLayout(command, paths.userHome, configMutation);
	seedAnonymousOpenClawAuthProbes(paths, command);
	flushPersistedStepRevisions(paths);
}

export function prepareRuntimePreinstallation(
	input: unknown,
	options: {
		home?: string;
		state?: string;
		uid?: number;
		gid?: number;
		hosted?: { paths: RuntimePaths };
	} = {},
) {
	const spec = preinstallationSpecSchema.parse(input);
	if (process.platform !== "linux" || process.arch !== spec.architecture)
		throw new Error("preinstallation architecture mismatch");
	const home = options.home ?? "/home/clawdi";
	const state = options.state ?? "/var/lib/clawdi";
	for (const path of [home, state]) {
		if (
			lstatSync(path).isSymbolicLink() ||
			!lstatSync(path).isDirectory() ||
			readdirSync(path).length
		) {
			throw new Error("preinstallation requires empty anonymous home and state directories");
		}
	}
	const paths = options.hosted?.paths;
	if (!paths) throw new Error("hosted runtime paths are required for anonymous preparation");
	const identity = { uid: options.uid ?? 10001, gid: options.gid ?? 10001 };
	const install = {
		authority: "official" as const,
		method: "official-installer" as const,
		url: OFFICIAL_INSTALL_URLS[spec.runtime],
		home,
		args: officialInstallArgs(spec.runtime, home),
	};
	const observation = observeRuntimeInstall(
		spec.runtime,
		{ enabled: true, install, services: {} },
		home,
		paths,
		identity,
	);
	if (observation.status === "install_failed" || !observation.commandPath || observation.error)
		throw new Error(observation.error ?? `anonymous ${spec.runtime} installation failed`);
	const command = observation.commandPath;
	const run = (args: string[], timeout: number): string => {
		const child = buildNumericUserCommand(identity.uid, identity.gid, command, args);
		const result = spawnSync(child.command, child.args, {
			cwd: home,
			env: anonymousInstallerEnvironment(home),
			encoding: "utf8",
			timeout,
			maxBuffer: 1024 * 1024,
		});
		if (result.error || result.status !== 0)
			throw new Error(`anonymous runtime health check failed (exit ${result.status ?? "timeout"})`);
		return result.stdout.trim();
	};
	const health = run(["--version"], 30_000);
	if (!health) throw new Error("anonymous runtime health check returned no version");
	const executableRevision = runtimeFileCurrentRevision(command);
	if (!executableRevision) throw new Error("installed runtime executable identity is unavailable");
	if (spec.runtime === "hermes") {
		prepareHermesDashboardBuild({
			home,
			revision: runtimeCommandVersionRevision(executableRevision, health),
			run: (args, cwd, timeout) => {
				const child = buildNumericUserCommand(identity.uid, identity.gid, "npm", args);
				const result = spawnSync(child.command, child.args, {
					cwd,
					env: anonymousInstallerEnvironment(home),
					encoding: "utf8",
					timeout,
				});
				if (result.error || result.status !== 0) throw new Error("Hermes dashboard build failed");
			},
			writeRevision(path, contents) {
				writePrivateFileAtomic(path, contents, { mode: 0o600 });
				chownSync(path, identity.uid, identity.gid);
			},
		});
	}
	const sourceIdentity = preinstalledSourceIdentity(spec.runtime, home);
	if (!sourceIdentity) throw new Error("installed runtime source identity is unavailable");
	const probes: PreinstalledProbes = {
		runtime: spec.runtime,
		command,
		home,
		executableRevision,
		sourceIdentity,
		version: health,
		...(spec.runtime === "hermes" ? { configPath: run(["config", "path"], 30_000) } : {}),
	};
	if (probes.configPath !== undefined && !isAbsolute(probes.configPath))
		throw new Error("installed Hermes config path is not absolute");
	if (!ensureHostedCodexCli(paths)) throw new Error("Codex preparation is disabled");
	if (spec.runtime === "openclaw") {
		prepareAnonymousOpenClawGateway(paths, identity);
		prepareOpenClawProbeResults(paths, command);
	}
	const cli = applyRuntimeCliDesiredState(
		{ clawdiCli: { packageSpec: spec.cliPackageSpec, registry: "https://registry.npmjs.org" } },
		paths,
	);
	if (cli.status === "error" || cli.status === "deferred" || cli.status === "not_requested")
		throw new Error(cli.error ?? `anonymous CLI installation failed (${cli.status})`);
	for (const cache of [".cache/npm", ".cache/uv", ".npm"])
		rmSync(join(home, cache), { recursive: true, force: true });
	const receipt = {
		...spec,
		preparedAt: new Date().toISOString(),
		health,
		probes,
		homeTreeSha256: preinstallationTreeSha256(home),
	};
	mkdirSync(join(state, "preinstallation"), { mode: 0o700 });
	const path = join(state, "preinstallation/receipt.json");
	writeFileSync(`${path}.tmp`, `${JSON.stringify(receipt)}\n`, { mode: 0o400, flag: "wx" });
	renameSync(`${path}.tmp`, path);
	return receipt;
}
