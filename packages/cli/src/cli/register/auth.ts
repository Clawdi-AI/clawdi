import { type Command, Option } from "commander";

export function registerAuth(program: Command): void {
	const authCmd = program.command("auth").description("Sign in to Clawdi");

	authCmd
		.command("login")
		.description("Sign in through your browser")
		.option(
			"--manual",
			"Paste an existing API key; new keys cannot be created. Use `clawdi auth login` (`--no-open` on a server)",
		)
		.option("--no-open", "Print the sign-in link and code without opening a browser")
		.addOption(new Option("--desktop").hideHelp())
		.addOption(new Option("--force").hideHelp())
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi auth login\n  $ clawdi auth login --no-open\n  $ clawdi auth login --manual",
		)
		.action(
			async (opts: { manual?: boolean; open?: boolean; desktop?: boolean; force?: boolean }) => {
				const { authLogin, authLoginDesktop } = await import("../../commands/auth.js");
				if (opts.desktop) {
					if (opts.manual || opts.open === false) {
						throw new Error("Desktop sign-in does not accept interactive sign-in options.");
					}
					await authLoginDesktop({ force: opts.force });
					return;
				}
				if (opts.force) throw new Error("--force is only available for Desktop sign-in.");
				await authLogin(opts);
			},
		);

	authCmd
		.command("desktop-session", { hidden: true })
		.description("Restore the embedded Desktop dashboard session")
		.option("--json", "Private machine-readable credential transport")
		.option("--session-user <id>", "Current Clerk user")
		.option("--session-id <id>", "Current Clerk session")
		.action(async (opts: { sessionUser?: string; sessionId?: string }) => {
			const { authDesktopSessionMachine } = await import("../../commands/auth.js");
			await authDesktopSessionMachine(opts);
		});

	authCmd
		.command("desktop-sign-out", { hidden: true })
		.description("Revoke the embedded Desktop dashboard session")
		.requiredOption("--session-id <id>", "Clerk session to revoke")
		.option("--json", "Private machine-readable output")
		.action(async (opts: { sessionId: string }) => {
			const { authDesktopSignOutMachine } = await import("../../commands/auth.js");
			await authDesktopSignOutMachine(opts.sessionId);
		});

	authCmd
		.command("complete")
		.description("Resume waiting for a pending sign-in")
		.action(async () => {
			const { authComplete } = await import("../../commands/auth.js");
			await authComplete();
		});

	authCmd
		.command("logout")
		.description("Remove local credentials")
		.action(async () => {
			const { authLogout } = await import("../../commands/auth.js");
			await authLogout();
		});

	authCmd
		.command("status")
		.description("Show credential source without printing secrets")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { authStatus } = await import("../../commands/auth.js");
			await authStatus(opts);
		});
}
