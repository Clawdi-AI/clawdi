import { type Command, Option } from "commander";

export function registerUpdate(program: Command): void {
	program
		.command("update")
		.description("Install the latest CLI through the current installation owner")
		.option("--check", "Only check for updates, don't install")
		.option(
			"-y, --yes",
			"Install without prompting (required to install from a non-interactive shell)",
		)
		.option("--json", "Output as JSON")
		.addOption(new Option("--background-worker").hideHelp())
		.addOption(new Option("--current-version <version>").hideHelp())
		.addOption(new Option("--native-identity").hideHelp())
		.addOption(new Option("--native-activate").hideHelp())
		.addOption(new Option("--native-auto-update").hideHelp())
		.addOption(new Option("--native-stage <path>").hideHelp())
		.addOption(new Option("--native-prefix <path>").hideHelp())
		.addOption(new Option("--native-version <version>").hideHelp())
		.addOption(new Option("--native-target <target>").hideHelp())
		.addOption(new Option("--native-lock-timeout-ms <milliseconds>").hideHelp())
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi update\n  $ clawdi update --yes\n  $ clawdi update --yes --json\n  $ clawdi update --check --json",
		)
		.action(async (opts) => {
			if (opts.nativeIdentity) {
				const { nativeIdentityOutput } = await import("../../lib/native-activation.js");
				console.log(nativeIdentityOutput());
				return;
			}
			if (opts.nativeActivate) {
				const { activateStagedNativeRelease } = await import("../../lib/native-activation.js");
				const { isNativeBuildTarget } = await import("../../lib/native-release-manifest.js");
				if (
					!opts.nativeStage ||
					!opts.nativePrefix ||
					!opts.nativeVersion ||
					!opts.nativeTarget ||
					!isNativeBuildTarget(opts.nativeTarget)
				) {
					throw new Error("native activation requires a valid stage, prefix, version, and target");
				}
				const timeoutMs =
					opts.nativeLockTimeoutMs === undefined ? undefined : Number(opts.nativeLockTimeoutMs);
				if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
					throw new Error("native activation lock timeout must be a non-negative number");
				}
				let result: Awaited<ReturnType<typeof activateStagedNativeRelease>>;
				try {
					result = await activateStagedNativeRelease(
						{
							stageDir: opts.nativeStage,
							prefix: opts.nativePrefix,
							version: opts.nativeVersion,
							target: opts.nativeTarget,
							automatic: opts.nativeAutoUpdate,
						},
						timeoutMs === undefined ? undefined : { timeoutMs },
					);
				} catch (error) {
					const { PrivateDirectoryLockTimeoutError } = await import(
						"../../lib/private-directory-lock.js"
					);
					if (error instanceof PrivateDirectoryLockTimeoutError) {
						process.exitCode = 75;
						return;
					}
					throw error;
				}
				if (result.skipped) {
					process.exitCode = 76;
					return;
				}
				console.log(result.launcher);
				return;
			}
			const { runBackgroundUpdateWorker, update } = await import("../../commands/update.js");
			if (opts.backgroundWorker) {
				if (!opts.currentVersion) {
					throw new Error("background update worker requires current version");
				}
				const result = await runBackgroundUpdateWorker({
					currentVersion: opts.currentVersion,
				});
				if (result === "failed") process.exitCode = 1;
				return;
			}
			await update(opts);
		});
}
