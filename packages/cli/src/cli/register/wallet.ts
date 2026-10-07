import type { Command } from "commander";
import { parsePositiveInteger } from "../../lib/cli-options.js";

export function registerWallet(program: Command): void {
	const walletCmd = program.command("wallet").description("Inspect Clawdi wallet");

	walletCmd
		.command("status")
		.description("Show authenticated wallet balance, binding, and USDC funding readiness")
		.option("--json", "Output as JSON")
		.action(async (opts: { json?: boolean }) => {
			const { runWalletStatusCommand } = await import("../../commands/wallet.js");
			await runWalletStatusCommand(opts);
		});

	walletCmd
		.command("transactions")
		.description("List wallet transactions")
		.option(
			"--limit <n>",
			"Maximum transactions to show (default: API default)",
			parsePositiveInteger,
		)
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi wallet transactions --limit 20 --json")
		.action(async (opts) => {
			const { walletTransactionsCommand } = await import("../../commands/wallet.js");
			await walletTransactionsCommand(opts);
		});

	walletCmd
		.command("usage")
		.description("Show usage for the API reporting period")
		.option("--days <n>", "Reporting period in days (default: API default)", parsePositiveInteger)
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi wallet usage --days 7 --json")
		.action(async (opts) => {
			const { walletUsageCommand } = await import("../../commands/wallet.js");
			await walletUsageCommand(opts);
		});

	walletCmd
		.command("portal")
		.description("Print the web billing URL")
		.addHelpText("after", "\nExample:\n  $ clawdi wallet portal")
		.action(async () => {
			const { walletPortalCommand } = await import("../../commands/wallet.js");
			await walletPortalCommand();
		});
}
