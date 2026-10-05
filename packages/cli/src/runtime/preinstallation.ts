import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../lib/codex-oauth-native-store";
import { writePrivateFileAtomic } from "../lib/private-file";
import { getCliVersion } from "../lib/version";
import { installRuntimeCliArchive } from "./cli-update";
import { egressEngineSchema } from "./egress-engine";
import { prefetchFileBrowserAsset } from "./file-browser-companion";
import { prepareHermesDashboardBuild } from "./hermes-dashboard-build";
import { resolveHostedOpenClawWorkspace } from "./hosted-openclaw-context";
import { ensureHostedCodexCli } from "./managed-codex-provider";
import { runtimeCommandVersionRevision, runtimeFileCurrentRevision } from "./manifest-install";
import { ensureRuntimeMitmproxy } from "./mitmproxy-fetch";
import { seedOpenClawMemorySearchLayout } from "./openclaw-provider-config";
import type { RuntimePaths } from "./paths";
import {
	flushPersistedStepRevisions,
	loadPersistedStepRevisions,
} from "./persisted-step-revisions";
import { type PreinstalledProbes, preinstalledSourceIdentity } from "./preinstalled-probes";
import { buildNumericUserCommand } from "./runtime-user-command";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sriSha512 = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
export const preinstallationSpecSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtime-preinstallation.v1"),
		imageFingerprint: sha256,
		architecture: z.enum(["x64", "arm64"]),
		cliPackageSpec: z.string().regex(/^clawdi@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
		cliIntegrity: sriSha512,
		egressEngine: egressEngineSchema.strict().optional(),
		fileBrowserAsset: z
			.object({
				url: z
					.string()
					.regex(
						/^https:\/\/github\.com\/gtsteffaniak\/filebrowser\/releases\/download\/[A-Za-z0-9._-]+\/linux-(?:amd64|arm64)-filebrowser$/,
					),
				sha256,
			})
			.strict()
			.optional(),
		runtime: z.enum(["openclaw", "hermes"]),
		runtimeVersion: z.string(),
		installerSha256: sha256,
		installerUrl: z.string().url(),
		runtimeTarballUrl: z
			.string()
			.regex(/^https:\/\/registry\.npmjs\.org\/openclaw\/-\/[A-Za-z0-9._-]+\.tgz$/)
			.optional(),
		runtimeIntegrity: sriSha512.optional(),
	})
	.strict()
	.superRefine((spec, ctx) => {
		const versionValid =
			spec.runtime === "openclaw"
				? semver.safeParse(spec.runtimeVersion).success
				: /^[a-f0-9]{40}$/.test(spec.runtimeVersion);
		const urlValid =
			spec.runtime === "openclaw"
				? spec.installerUrl === "https://openclaw.ai/install-cli.sh"
				: spec.installerUrl ===
					`https://raw.githubusercontent.com/NousResearch/hermes-agent/${spec.runtimeVersion}/scripts/install.sh`;
		const artifactValid =
			spec.runtime === "openclaw"
				? Boolean(spec.runtimeTarballUrl && spec.runtimeIntegrity)
				: spec.runtimeTarballUrl === undefined && spec.runtimeIntegrity === undefined;
		if (!versionValid || !urlValid || !artifactValid)
			ctx.addIssue({ code: "custom", message: "exact official runtime identity is required" });
	});
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

/**
 * Version-only OpenClaw probe results that first-boot convergence would
 * otherwise compute: the official workspace roster for the untouched default
 * config and the config-schema memory-search layout. Keys are the exact
 * executable/SDK/config revisions, so any tenant change recomputes them.
 */
function prepareOpenClawProbeResults(paths: RuntimePaths, command: string): void {
	loadPersistedStepRevisions(paths);
	resolveHostedOpenClawWorkspace(paths.userHome);
	const configMutation = resolveOpenClawSdkExport(
		paths.userHome,
		[command],
		OPENCLAW_SDK_EXPORT_PATHS.configMutation,
	);
	if (configMutation) seedOpenClawMemorySearchLayout(command, paths.userHome, configMutation);
	flushPersistedStepRevisions(paths);
}

export function prepareRuntimePreinstallation(
	input: unknown,
	installer: string,
	options: {
		home?: string;
		state?: string;
		uid?: number;
		gid?: number;
		runtimeArtifact?: string;
		/** Hosted managed layout: install the CLI archive and shared tool artifacts. */
		hosted?: { paths: RuntimePaths; cliArchive: string };
	} = {},
) {
	const spec = preinstallationSpecSchema.parse(input);
	if (process.platform !== "linux" || process.arch !== spec.architecture)
		throw new Error("preinstallation architecture mismatch");
	if (spec.cliPackageSpec !== `clawdi@${getCliVersion()}`)
		throw new Error("preinstallation CLI version mismatch");
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
	if (
		options.hosted &&
		`sha512-${createHash("sha512").update(readFileSync(options.hosted.cliArchive)).digest("base64")}` !==
			spec.cliIntegrity
	)
		throw new Error("preinstallation CLI archive integrity mismatch");
	const script = readFileSync(installer);
	if (createHash("sha256").update(script).digest("hex") !== spec.installerSha256)
		throw new Error("preinstallation installer integrity mismatch");
	if (spec.runtime === "openclaw" && !script.includes(Buffer.from("--runtime-only")))
		throw new Error("official installer must support --runtime-only");
	const temporary = mkdtempSync(join(tmpdir(), "clawdi-preinstallation-"));
	chmodSync(temporary, 0o755);
	try {
		let pinnedVersion = spec.runtimeVersion;
		if (spec.runtime === "openclaw") {
			const download =
				options.runtimeArtifact === undefined
					? spawnSync(
							"curl",
							[
								"--fail",
								"--silent",
								"--show-error",
								"--proto",
								"=https",
								"--max-time",
								"180",
								spec.runtimeTarballUrl ?? "",
							],
							{
								env: anonymousInstallerEnvironment(home),
								timeout: 190_000,
								maxBuffer: 250 * 1024 * 1024,
							},
						)
					: undefined;
			if (download?.error || (download && download.status !== 0))
				throw new Error("official runtime artifact download failed");
			const archive =
				options.runtimeArtifact !== undefined
					? readFileSync(options.runtimeArtifact)
					: download?.stdout;
			if (
				!archive ||
				`sha512-${createHash("sha512").update(archive).digest("base64")}` !== spec.runtimeIntegrity
			)
				throw new Error("official runtime artifact integrity mismatch");
			pinnedVersion = join(temporary, "openclaw.tgz");
			writeFileSync(pinnedVersion, archive, { mode: 0o444, flag: "wx" });
			// The builder uses umask 077; the dropped runtime user must read this
			// verified root-owned artifact through its traversable temporary directory.
			chmodSync(pinnedVersion, 0o444);
		}
		const args =
			spec.runtime === "openclaw"
				? [
						"--prefix",
						join(home, ".local"),
						"--version",
						pinnedVersion,
						"--runtime-only",
						"--no-onboard",
					]
				: [
						"--commit",
						spec.runtimeVersion,
						"--force-commit",
						"--skip-setup",
						"--skip-browser",
						"--non-interactive",
					];
		const env = anonymousInstallerEnvironment(home);
		const identity = { uid: options.uid ?? 10001, gid: options.gid ?? 10001 };
		function run(
			command: string,
			commandArgs: string[],
			timeout: number,
			options: { cwd?: string; includeStderr?: boolean } = {},
		) {
			const child =
				identity.uid === process.getuid?.() && identity.gid === process.getgid?.()
					? { command, args: commandArgs }
					: buildNumericUserCommand(identity.uid, identity.gid, command, commandArgs);
			const result = spawnSync(child.command, child.args, {
				cwd: options.cwd ?? home,
				env,
				encoding: "utf8",
				timeout,
				maxBuffer: 1024 * 1024,
			});
			if (result.error || result.status !== 0) {
				// Anonymous build diagnostics contain no inherited credentials.
				if (result.stdout) process.stderr.write(result.stdout.slice(-8192));
				if (result.stderr) process.stderr.write(result.stderr.slice(-8192));
				throw new Error(
					`anonymous runtime installation or health check failed (${command}, exit ${result.status ?? "timeout"})`,
				);
			}
			return options.includeStderr
				? [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
				: result.stdout.trim();
		}
		run("bash", ["--noprofile", "--norc", installer, ...args], 30 * 60 * 1000);
		const command = join(home, ".local/bin", spec.runtime);
		const health = run(command, ["--version"], 30_000, { includeStderr: true });
		if (!health) throw new Error("anonymous runtime health check returned no version");
		const installedIdentity =
			spec.runtime === "openclaw"
				? z
						.object({ version: z.string() })
						.parse(
							JSON.parse(
								readFileSync(
									join(home, ".local/tools/node/lib/node_modules/openclaw/package.json"),
									"utf8",
								),
							),
						).version
				: run("git", ["-C", join(home, ".hermes/hermes-agent"), "rev-parse", "HEAD"], 10_000);
		if (installedIdentity !== spec.runtimeVersion)
			throw new Error("installed runtime identity mismatch");
		if (spec.runtime === "hermes") {
			const executableRevision = runtimeFileCurrentRevision(command);
			if (!executableRevision)
				throw new Error("installed runtime executable identity is unavailable");
			prepareHermesDashboardBuild({
				home,
				revision: runtimeCommandVersionRevision(executableRevision, health),
				run: (args, cwd, timeout) => {
					run("npm", args, timeout, { cwd });
				},
				writeRevision(path, contents) {
					writePrivateFileAtomic(path, contents, { mode: 0o600 });
					chownSync(path, identity.uid, identity.gid);
				},
			});
		}
		const executableRevision = runtimeFileCurrentRevision(command);
		const sourceIdentity = preinstalledSourceIdentity(spec.runtime, home);
		if (
			!executableRevision ||
			sourceIdentity !==
				(spec.runtime === "hermes"
					? `git:${spec.runtimeVersion}`
					: `npm:openclaw@${spec.runtimeVersion}`)
		)
			throw new Error("installed runtime probe identity is unavailable");
		const probes: PreinstalledProbes = {
			runtime: spec.runtime,
			command,
			home,
			executableRevision,
			sourceIdentity,
			version: health,
			...(spec.runtime === "hermes"
				? { configPath: run(command, ["config", "path"], 30_000) }
				: {}),
		};
		if (probes.configPath !== undefined && !isAbsolute(probes.configPath))
			throw new Error("installed Hermes config path is not absolute");
		if (options.hosted) {
			const { paths, cliArchive } = options.hosted;
			// The same content-addressed checks used by tenant convergence then find
			// these tenant-independent artifacts present and skip their downloads.
			if (spec.egressEngine) {
				const egress = ensureRuntimeMitmproxy(spec.egressEngine, paths);
				if (egress.status !== "ready")
					throw new Error(`egress engine preparation failed: ${egress.error}`);
			}
			if (spec.fileBrowserAsset) prefetchFileBrowserAsset(paths, spec.fileBrowserAsset);
			if (!ensureHostedCodexCli(paths)) throw new Error("Codex preparation is disabled");
			if (spec.runtime === "openclaw") prepareOpenClawProbeResults(paths, command);
			installRuntimeCliArchive(paths, spec.cliPackageSpec, cliArchive);
		}
		// Only caches explicitly redirected by this command are disposable.
		// Keep upstream-generated runtime defaults and bundled software unchanged.
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
		chmodSync(`${path}.tmp`, 0o400);
		renameSync(`${path}.tmp`, path);
		return receipt;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
