import type { Command } from "commander";

export function registerRuntime(program: Command): void {
	const runtimeCmd = program
		.command("runtime", { hidden: true })
		.description("Managed Hosted runtime control plane");

	runtimeCmd
		.command("prepare", { hidden: true })
		.description("Prepare anonymous software-only runtime data without Cloud identity")
		.requiredOption("--spec <path>", "Strict preinstallation specification")
		.requiredOption("--installer <path>", "SHA256-verified official installer")
		.requiredOption("--cli-archive <path>", "Integrity-verified npm archive of this CLI release")
		.action(async (opts: { spec: string; installer: string; cliArchive: string }) => {
			const { readFileSync } = await import("node:fs");
			const { prepareRuntimePreinstallation } = await import("../../runtime/preinstallation.js");
			const { getRuntimePaths } = await import("../../runtime/paths.js");
			if (process.getuid?.() !== 0) throw new Error("anonymous preparation requires root");
			Object.assign(process.env, {
				CLAWDI_RUNTIME_MODE: "hosted",
				CLAWDI_RUNTIME_USER: "clawdi",
				CLAWDI_RUNTIME_HOME: "/home/clawdi",
			});
			console.log(
				JSON.stringify(
					prepareRuntimePreinstallation(
						JSON.parse(readFileSync(opts.spec, "utf8")),
						opts.installer,
						{
							hosted: { paths: getRuntimePaths({ mode: "hosted" }), cliArchive: opts.cliArchive },
						},
					),
				),
			);
		});

	runtimeCmd
		.command("warm", { hidden: true })
		.description("Experimental: start tenant-independent services in an unclaimed pool instance")
		.option("--runtime <runtime>", "openclaw or hermes", "openclaw")
		.action(async (opts: { runtime: string }) => {
			const { getRuntimePaths } = await import("../../runtime/paths.js");
			if (process.getuid?.() !== 0) throw new Error("runtime warm requires root");
			const paths = getRuntimePaths({ mode: "hosted" });
			if (opts.runtime === "hermes") {
				const { warmHostedHermesRuntime } = await import("../../runtime/runtime-warm-hermes.js");
				await warmHostedHermesRuntime(paths);
			} else if (opts.runtime === "openclaw") {
				const { warmHostedOpenClawRuntime } = await import("../../runtime/runtime-warm.js");
				await warmHostedOpenClawRuntime(paths);
			} else {
				throw new Error(`runtime warm does not support ${opts.runtime}`);
			}
		});

	runtimeCmd
		.command("init", { hidden: true })
		.description("Converge a hosted runtime from controller desired state")
		.option("--non-interactive", "Required for hosted boot; never prompt")
		.option("--json", "Output as JSON")
		.action(async (opts: { nonInteractive?: boolean; json?: boolean }) => {
			const { runtimeInit } = await import("../../commands/runtime.js");
			await runtimeInit(opts);
		});

	runtimeCmd
		.command("watch", { hidden: true })
		.description("Watch hosted runtime desired state and apply live changes")
		.option("--interval-ms <ms>", "Polling interval in milliseconds")
		.option("--self-heal-ms <ms>", "Maximum interval before forcing a full manifest fetch")
		.option("--once", "Run one watch iteration and exit")
		.option("--json", "Output as JSON")
		.action(
			async (opts: {
				intervalMs?: string;
				selfHealMs?: string;
				once?: boolean;
				json?: boolean;
			}) => {
				const { runtimeWatch } = await import("../../commands/runtime.js");
				await runtimeWatch(opts);
			},
		);

	runtimeCmd
		.command("provider-handoff", { hidden: true })
		.description("Apply an explicitly authorized provider identity journal CAS")
		.requiredOption("--handoff-id <id>", "Current Cloud handoff receipt ID")
		.action(async (opts: { handoffId: string }) => {
			const { providerIdentityHandoff } = await import("../../runtime/provider-handoff.js");
			await providerIdentityHandoff(opts.handoffId);
		});

	runtimeCmd
		.command("verify", { hidden: true })
		.description("Validate hosted runtime CLI modules and cached manifest")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { runtimeVerify } = await import("../../commands/runtime-doctor.js");
			await runtimeVerify(opts);
		});

	runtimeCmd
		.command("sidecar", { hidden: true })
		.description("Run the hosted runtime egress sidecar")
		.action(async () => {
			const { runtimeSidecar } = await import("../../runtime/egress-sidecar.js");
			await runtimeSidecar();
		});

	runtimeCmd
		.command("status", { hidden: true })
		.description("Show managed Hosted runtime boot status")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { runtimeStatus } = await import("../../commands/runtime-doctor.js");
			await runtimeStatus(opts);
		});

	runtimeCmd
		.command("doctor", { hidden: true })
		.description("Diagnose hosted runtime policy, paths, and last boot state")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { runtimeDoctor } = await import("../../commands/runtime-doctor.js");
			await runtimeDoctor(opts);
		});
}
