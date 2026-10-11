import {
	appendFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { nativeLauncherPath } from "../../src/cli-compat";
import { writeFixtureNativeMetadata } from "./native-layout";

declare const CLI_FIXTURE_VERSION: string;
const version = CLI_FIXTURE_VERSION;
const configuredRoot = process.env.CLAWDI_NATIVE_E2E_ROOT;
if (!configuredRoot) throw new Error("Missing native CLI e2e root.");
const root = configuredRoot;
const home = join(root, "home");
const prefix = join(home, ".local");
const launcher = nativeLauncherPath(process.platform, home);
const unit = join(root, "unit.json");
const auth = join(root, "signed-in");
const native = process.execPath.startsWith(join(prefix, "share", "clawdi", "versions"));
const args = process.argv.slice(2);
appendFileSync(
	join(root, "calls.jsonl"),
	`${JSON.stringify({
		version,
		native,
		args,
		noAutoUpdate: process.env.CLAWDI_NO_AUTO_UPDATE,
		desktopRuntime: process.env.CLAWDI_DESKTOP_RUNTIME,
	})}\n`,
);

// The CLI and supervisor are fake. The actual Electron app, resolver, IPC and
// Connect renderer run unchanged; no production download URL is overridden.
function activate(next: string): void {
	const file = process.platform === "win32" ? "clawdi.exe" : "clawdi";
	const directory = join(
		prefix,
		"share",
		"clawdi",
		"versions",
		`${next}-${process.platform}-${process.arch}`,
	);
	mkdirSync(directory, { recursive: true });
	if (!existsSync(join(directory, file)))
		cpSync(
			join(root, `fixture-${next}${process.platform === "win32" ? ".exe" : ""}`),
			join(directory, file),
		);
	writeFixtureNativeMetadata(directory, next);
	if (process.platform === "win32") {
		const current = dirname(launcher);
		const staging = `${current}.next`;
		const previous = `${current}.previous`;
		symlinkSync(directory, staging, "junction");
		if (existsSync(current)) renameSync(current, previous);
		renameSync(staging, current);
		rmSync(previous, { recursive: true, force: true });
	} else {
		mkdirSync(dirname(launcher), { recursive: true });
		symlinkSync(join(directory, file), `${launcher}.next`);
		renameSync(`${launcher}.next`, launcher);
	}
}

function installUnit(): void {
	writeFileSync(
		unit,
		JSON.stringify({
			command: native ? launcher : process.execPath,
			executable: realpathSync(native ? launcher : process.execPath),
			version,
			noAutoUpdate: process.env.CLAWDI_NO_AUTO_UPDATE,
		}),
	);
}

switch (args.slice(0, 2).join(" ")) {
	case "update --native-identity":
		console.log(`${version}\t${process.platform}-${process.arch}`);
		break;
	case "capabilities --json":
		console.log(
			JSON.stringify({
				schemaVersion: "clawdi.capabilities.v1",
				capabilities: { updateMode: native ? "local-self-update" : "desktop-managed" },
			}),
		);
		break;
	case "update --native-bootstrap": {
		const foreign =
			existsSync(launcher) &&
			(process.platform === "win32" ||
				!lstatSync(launcher).isSymbolicLink() ||
				!realpathSync(launcher).startsWith(join(prefix, "share", "clawdi", "versions")));
		const status = existsSync(join(root, "offline"))
			? "failed"
			: foreign
				? "foreign-owner"
				: "installed";
		if (status === "installed") activate(version);
		console.log(
			JSON.stringify({ schemaVersion: "clawdi.nativeBootstrap.v1", status, version, launcher }),
		);
		if (status !== "installed") process.exitCode = 1;
		break;
	}
	case "update --fixture-auto-update":
		activate("0.16.9");
		// A fake supervisor re-execs the same stable command after activation.
		writeFileSync(
			unit,
			JSON.stringify({ command: launcher, executable: realpathSync(launcher), version: "0.16.9" }),
		);
		break;
	case "auth status":
		console.log(
			JSON.stringify({
				schemaVersion: "clawdi.authStatus.v1",
				authenticated: existsSync(auth),
				credentialType: "clerk-oauth",
				user: { id: "native-e2e" },
			}),
		);
		break;
	case "auth login":
		writeFileSync(auth, "fixture");
		console.log(
			JSON.stringify({
				schemaVersion: "clawdi.desktopLogin.v1",
				status: "authenticated",
				user: { id: "native-e2e" },
			}),
		);
		break;
	case "daemon doctor": {
		const stored: unknown = existsSync(unit) ? JSON.parse(readFileSync(unit, "utf8")) : null;
		const daemon =
			stored && typeof stored === "object" && "version" in stored && "executable" in stored
				? stored
				: null;
		console.log(
			JSON.stringify({
				schemaVersion: "clawdi.daemonDoctor.v2",
				cli_version: version,
				singleton_unit_installed: Boolean(daemon),
				singleton_unit_running: Boolean(daemon),
				agents: daemon
					? [
							{
								heartbeat: { status: "live" },
								daemon_version: daemon.version,
								daemon_executable: daemon.executable,
							},
						]
					: [],
			}),
		);
		break;
	}
	case "agent detect":
		console.log(
			JSON.stringify({
				schemaVersion: existsSync(join(root, "future-schema"))
					? "clawdi.agentDetection.v2"
					: "clawdi.agentDetection.v1",
				agents: [
					{
						type: "codex",
						displayName: "Codex",
						detected: true,
						registered: existsSync(unit),
						version: "fixture",
						inspection: "complete",
					},
				],
			}),
		);
		break;
	case "agent reconnect":
		console.log(
			JSON.stringify({ schemaVersion: "clawdi.agentReconnectCandidates.v1", agents: [] }),
		);
		break;
	case "daemon install":
		installUnit();
		break;
	case "daemon restart":
	case "setup --agent":
		break;
	default:
		throw new Error("Unexpected native CLI e2e command.");
}
