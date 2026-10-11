import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { isClerkOAuthAuth } from "../lib/clerk-oauth";
import { emit } from "../lib/command-output";
import { getClawdiDir, getStoredAuth } from "../lib/config";
import {
	findNativeUninstallOwnership,
	removeNativeCli,
	removeNativeProfileBlocks,
} from "../lib/native-uninstall";
import { progressLine } from "../lib/progress";
import { confirmOrRequireYes } from "../lib/prompts";
import { uninstall as uninstallDaemon } from "../serve/installer";
import { authLogout } from "./auth";
import { teardown } from "./teardown";

export interface UninstallOptions {
	removeCli?: boolean;
	yes?: boolean;
	json?: boolean;
}
export interface UninstallStep {
	step: string;
	status: "removed" | "skipped" | "failed" | "scheduled";
	message: string;
}

export async function uninstall(
	opts: UninstallOptions,
	runtime: {
		home?: string;
		uninstallDaemon?: typeof uninstallDaemon;
		teardown?: typeof teardown;
		logout?: typeof authLogout;
	} = {},
) {
	const steps: UninstallStep[] = [];
	const report = (status: "completed" | "failed" | "cancelled") => {
		const result = { schemaVersion: "clawdi.uninstall.v1", status, steps };
		if (opts.json) emit(result);
		else {
			for (const step of steps)
				progressLine(`${step.status === "failed" ? "✗" : "✓"} ${step.step}: ${step.message}`);
			progressLine(
				status === "failed"
					? "Uninstall finished with failures. Account data was kept."
					: status === "cancelled"
						? "Uninstall canceled."
						: "Local uninstall complete. Account data was kept.",
			);
		}
		return result;
	};
	if (
		!(await confirmOrRequireYes("Uninstall Clawdi from this computer?", {
			yes: opts.yes,
			action: "uninstall Clawdi",
		}))
	)
		return report("cancelled");
	const home = runtime.home ?? homedir();
	const native: { ownership: ReturnType<typeof findNativeUninstallOwnership> } = {
		ownership: null,
	};
	const run = async (
		step: string,
		action: () => Promise<Omit<UninstallStep, "step">> | Omit<UninstallStep, "step">,
	) => {
		try {
			steps.push({ step, ...(await action()) });
		} catch {
			steps.push({
				step,
				status: "failed",
				message: `Could not complete ${step}. Check permissions and retry.`,
			});
		}
	};
	await run("native-install", () => {
		native.ownership = findNativeUninstallOwnership(home);
		return {
			status: "skipped",
			message: native.ownership
				? "Native CLI ownership verified."
				: "No owned native CLI found; npm and Homebrew installations are kept.",
		};
	});
	await run("daemon", () => ({
		status: (runtime.uninstallDaemon ?? uninstallDaemon)().removed ? "removed" : "skipped",
		message: "Background service stopped and removed, or already absent.",
	}));
	await run("integrations", async () => {
		const agents = await (runtime.teardown ?? teardown)({
			all: true,
			yes: true,
			reportFailures: true,
			json: true,
			silentResult: true,
		});
		if (!agents || agents.some((agent) => agent.errors?.length))
			throw new Error("Integration cleanup failed");
		return {
			status: agents.length ? "removed" : "skipped",
			message: "Local agent integrations removed, or already absent.",
		};
	});
	await run("auth", async () => {
		const needsRevocation = isClerkOAuthAuth(getStoredAuth());
		const result = await (runtime.logout ?? authLogout)();
		if (result?.environmentCredential)
			return {
				status: "failed",
				message:
					"Unset CLAWDI_AUTH_TOKEN to remove the environment credential. Local state will still be removed.",
			};
		if (needsRevocation && !result?.remoteRevoked)
			return {
				status: "failed",
				message:
					"Remote sign-in could not be revoked. Revoke the Clawdi app in your Clerk account.",
			};
		return {
			status: result?.loggedOut ? "removed" : "skipped",
			message: "Signed out, or already signed out. Account data stays.",
		};
	});
	await run("local-state", () => {
		const directory = resolve(getClawdiDir());
		const homeFromState = relative(directory, resolve(home));
		if (
			directory === parse(directory).root ||
			(!isAbsolute(homeFromState) && homeFromState.split(sep)[0] !== "..")
		) {
			return {
				status: "failed",
				message:
					"Refusing to remove your home directory or its parents. Set CLAWDI_HOME to Clawdi's local state directory.",
			};
		}
		const present = existsSync(directory);
		rmSync(directory, { recursive: true, force: true });
		return {
			status: present ? "removed" : "skipped",
			message: "Local Clawdi state removed, or already absent.",
		};
	});
	// Desktop's explicit unchecked checkbox takes precedence over automatic removal.
	const removeCli =
		opts.removeCli ||
		(native.ownership?.installedBy === "desktop" && process.env.CLAWDI_UNINSTALL_KEEP_CLI !== "1");
	await run("cli", async () =>
		native.ownership && removeCli
			? await removeNativeCli(native.ownership)
			: { status: "skipped", message: "Command-line tool kept." },
	);
	await run("shell-profiles", () =>
		native.ownership && removeCli
			? removeNativeProfileBlocks(home, native.ownership.prefix)
			: { status: "skipped", message: "Shell profiles kept." },
	);
	const failed = steps.some((step) => step.status === "failed");
	if (failed) process.exitCode = 1;
	return report(failed ? "failed" : "completed");
}
