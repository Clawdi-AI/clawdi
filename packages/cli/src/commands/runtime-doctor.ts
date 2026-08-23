import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import { z } from "zod";
import { getCliVersion } from "../lib/version";
import { readRuntimeApplyContext } from "../runtime/apply-identity";
import { readHostPolicy } from "../runtime/host-policy";
import { inspectHostedRuntimeIdentity } from "../runtime/hosted-runtime-contract";
import { hostedRuntimeBundleV2Schema } from "../runtime/manifest-source";
import { getRuntimePaths } from "../runtime/paths";
import { assertRuntimePlatformRoots, readRuntimeBootStatus } from "../runtime/state";
import { toErrorMessage } from "../serve/log";

const ACTIVE_CLI_VERSION = getCliVersion();

interface RuntimeVerifyOptions {
	json?: boolean;
}

interface RuntimeDoctorCheck {
	name: string;
	ok: boolean;
	detail?: string;
	hint?: string;
}

function writable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function readable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

export async function runtimeVerify(opts: RuntimeVerifyOptions = {}) {
	const paths = getRuntimePaths();
	const manifestCacheExists = existsSync(paths.manifestLastGood);
	const errors: string[] = [];
	if (manifestCacheExists) {
		try {
			const raw = JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")) as unknown;
			const parsed = hostedRuntimeBundleV2Schema.safeParse(raw);
			if (!parsed.success) {
				errors.push(`cached manifest parse failed: ${z.prettifyError(parsed.error)}`);
			}
		} catch (error) {
			errors.push(`cached manifest parse failed: ${toErrorMessage(error)}`);
		}
	}
	const result = {
		schemaVersion: "clawdi.runtimeVerify.v1",
		status: errors.length === 0 ? "ok" : "error",
		cliVersion: ACTIVE_CLI_VERSION,
		manifestCache: {
			path: paths.manifestLastGood,
			exists: manifestCacheExists,
			valid: manifestCacheExists ? errors.length === 0 : null,
		},
		errors,
	};
	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(result, null, 2));
	} else if (errors.length === 0) {
		console.log(chalk.green("runtime verify ok"));
	} else {
		console.log(chalk.red(errors[0]));
	}
	if (errors.length > 0) process.exitCode = 1;
}

export async function runtimeStatus(opts: { json?: boolean } = {}) {
	const paths = getRuntimePaths();
	const read = readRuntimeBootStatus(paths);
	const payload = {
		schemaVersion: "clawdi.runtimeStatus.v1",
		runtimeMode: paths.mode,
		paths: {
			bootStatus: paths.bootStatus,
		},
		...read,
	};
	if (read.error || read.status?.status === "error") process.exitCode = 1;

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(chalk.bold("clawdi runtime status"));
	console.log();
	if (!read.exists) {
		console.log(chalk.gray("  No runtime boot status has been written yet."));
		return;
	}
	if (read.error) {
		console.log(chalk.red(`  Could not read ${read.source}: ${read.error}`));
		return;
	}
	if (!read.status) {
		console.log(chalk.yellow("  Runtime status files exist, but boot-status.json is missing."));
		return;
	}
	console.log(`  Mode: ${read.status?.mode ?? "unknown"}`);
	console.log(`  Status: ${read.status?.status ?? "unknown"}`);
	console.log(`  Stage: ${read.status?.stage ?? "unknown"}`);
	console.log(chalk.gray(`  Source: ${read.source}`));
	if (read.status?.error) console.log(chalk.yellow(`  Error: ${read.status.error}`));
}

export async function runtimeDoctor(opts: { json?: boolean } = {}) {
	const paths = getRuntimePaths();
	const policy = readHostPolicy(paths.hostPolicy);
	const lastStatus = readRuntimeBootStatus(paths);
	const identity = inspectHostedRuntimeIdentity(paths);
	let runtimeContextDetail: string;
	let runtimeContextOk = false;
	try {
		const context = readRuntimeApplyContext();
		runtimeContextOk = context.backend === "incus";
		runtimeContextDetail = context.backend;
	} catch (error) {
		runtimeContextDetail = toErrorMessage(error);
	}
	let platformRootsOk = true;
	let platformRootsDetail = "trusted";
	try {
		assertRuntimePlatformRoots(paths);
	} catch (error) {
		platformRootsOk = false;
		platformRootsDetail = toErrorMessage(error);
	}
	const checks: RuntimeDoctorCheck[] = [
		{
			name: "Runtime mode",
			ok: identity.mode.ok,
			detail: identity.mode.error ?? identity.mode.detail,
			hint: "Set CLAWDI_RUNTIME_MODE=hosted explicitly; host policy files do not select runtime mode.",
		},
		{
			name: "Hosted policy",
			ok: policy.exists && policy.valid,
			detail: policy.valid ? policy.source : (policy.error ?? "missing"),
			hint: "Hosted mode uses the built-in policy; policy files are ignored.",
		},
		{
			name: "Runtime identity",
			ok: identity.user.ok,
			detail: identity.user.error ?? identity.user.detail,
			hint: "The hosted tenant must run as clawdi with the expected non-root UID and GID.",
		},
		{
			name: "Runtime context backend",
			ok: runtimeContextOk,
			detail: runtimeContextDetail,
			hint: "Hosted v2 requires a valid runtime context attested with backend=incus.",
		},
		{
			name: "Platform roots",
			ok: platformRootsOk,
			detail: platformRootsDetail,
			hint: "Platform roots must remain real directories owned by the system boundary.",
		},
		{
			name: "Service state",
			ok: existsSync(paths.serviceStateRoot) && writable(paths.serviceStateRoot),
			detail: paths.serviceStateRoot,
			hint: "The hosted service-state directory must be writable by the platform service.",
		},
		{
			name: "Runtime HOME",
			ok: identity.home.ok && existsSync(paths.userHome) && writable(paths.userHome),
			detail: identity.home.error ?? paths.userHome,
			hint: "Hosted HOME must resolve to /home/clawdi and be a writable persistent volume.",
		},
		{
			name: "Ephemeral runtime state",
			ok: existsSync(paths.runRoot),
			detail: paths.runRoot,
			hint: "The runtime tmpfs path should be recreated on each boot and owned by the system boundary.",
		},
		{
			name: "Runtime auth token",
			ok: !existsSync(paths.daemonAuthToken) || readable(paths.daemonAuthToken),
			detail: existsSync(paths.daemonAuthToken) ? "present" : "absent",
		},
		{
			name: "Last boot status",
			ok:
				!lastStatus.exists ||
				(lastStatus.status?.status === "ok" && lastStatus.status.errors.length === 0),
			detail: !lastStatus.exists
				? "none"
				: (lastStatus.error ??
					`${lastStatus.status?.status ?? "unknown"} / ${lastStatus.status?.mode ?? "unknown"}`),
			hint: "Run `clawdi runtime status` for the last boot result.",
		},
	];
	const failed = checks.filter((check) => !check.ok).length;

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(checks, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	console.log(chalk.bold("clawdi runtime doctor"));
	console.log();
	for (const check of checks) {
		const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
		const detail = check.detail ? chalk.gray(` — ${check.detail}`) : "";
		console.log(`  ${icon} ${check.name}${detail}`);
		if (!check.ok && check.hint) console.log(chalk.gray(`     ${check.hint}`));
	}
	if (failed > 0) process.exitCode = 1;
}
