import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	installWindowsTask,
	restartWindowsTask,
	stopWindowsTask,
	uninstallWindowsTask,
	windowsTaskInstalled,
	windowsTaskRunning,
} from "../../../../packages/cli/src/serve/windows-task";

// Fake account/Agent responses; the actual production Task Scheduler adapter
// supervises this compiled executable, so Windows holds a real executable lock.
const root = process.env.CLAWDI_HOME;
const log = process.env.CLAWDI_DESKTOP_UPDATE_E2E_CLI_LOG;
if (!root || !log) throw new Error("Missing Windows e2e environment.");
mkdirSync(root, { recursive: true });
const args = process.argv.slice(2);
appendFileSync(log, `${args.join(" ")}\n`);
if (args[0] === "--serve") {
	appendFileSync(join(root, "service-starts.log"), `${process.execPath}\n`);
	console.log("Windows update e2e task started");
	// A hung harness cannot leave a permanent fixture daemon behind.
	setTimeout(() => process.exit(0), 10 * 60_000);
} else {
	switch (`${args[0]} ${args[1]}`) {
		case "update --native-identity":
			console.log("0.0.0-smoke\twin32-x64");
			break;
		case "auth status":
			console.log(
				JSON.stringify({
					schemaVersion: "clawdi.authStatus.v1",
					authenticated: true,
					credentialType: "clerk-oauth",
					user: { id: "update-e2e" },
				}),
			);
			break;
		case "agent detect":
			console.log(
				JSON.stringify({
					schemaVersion: "clawdi.agentDetection.v1",
					agents: [
						{
							type: "claude_code",
							displayName: "Claude Code",
							detected: true,
							registered: true,
							inspection: "complete",
							version: "fixture",
						},
					],
				}),
			);
			break;
		case "daemon doctor": {
			const running = windowsTaskRunning();
			console.log(
				JSON.stringify({
					schemaVersion: "clawdi.daemonDoctor.v2",
					cli_version: "0.0.0-smoke",
					singleton_unit_installed: windowsTaskInstalled(),
					singleton_unit_running: running,
					agents: running
						? [
								{
									heartbeat: { status: "live" },
									daemon_version: "0.0.0-smoke",
									daemon_executable: process.execPath,
								},
							]
						: [],
				}),
			);
			break;
		}
		case "daemon install":
			installWindowsTask(root, { command: process.execPath, args: ["--serve"], entryPath: null }, [
				{ key: "CLAWDI_HOME", value: root },
				{ key: "CLAWDI_DESKTOP_UPDATE_E2E_CLI_LOG", value: log },
			]);
			break;
		case "daemon restart":
			restartWindowsTask();
			break;
		case "daemon stop":
			stopWindowsTask();
			break;
		case "daemon uninstall":
			uninstallWindowsTask(root);
			break;
		default:
			throw new Error(`Unexpected Windows e2e CLI call: ${args.join(" ")}`);
	}
}
