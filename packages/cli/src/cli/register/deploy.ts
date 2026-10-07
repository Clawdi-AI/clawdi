import type { Command } from "commander";

export function registerDeploy(program: Command): void {
	program
		.command("deploy")
		.description("Create a Cloud Agent with an interactive, payment-aware wizard")
		.option("--runtime <runtime>", "Runtime: hermes or openclaw")
		.option(
			"--provider <provider>",
			"AI provider: managed, unmanaged, or an exact saved provider ID",
		)
		.option(
			"--model <model>",
			"Primary model id (required when a saved provider has no unique default)",
		)
		.option("--compute <tier>", "Compute: basic or performance")
		.option("--term <months>", "Billing term for paid compute: 1 or 12")
		.option("--payment <method>", "Paid compute payment: wallet or card")
		.option("--name <name>", "Agent display name")
		.option("--language <code>", "Language code or default")
		.option("--timezone <timezone>", "IANA timezone or empty for runtime default")
		.option(
			"--request-id <uuid>",
			"Stable UUID for safe retries (required for every non-interactive deploy)",
		)
		.option("-y, --yes", "Confirm the Cloud Agent and any exact wallet debit")
		.option("--no-wait", "Return after the server accepts the request")
		.option("--no-open", "Print secure card checkout without opening a browser")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi deploy
  $ clawdi deploy --runtime hermes --provider managed --model <id> --compute basic --request-id <uuid> --yes --json
  # Native saved provider: choose models inside the agent
  $ clawdi deploy --provider <saved-provider-id> --compute basic --request-id <uuid> --yes --json
  # Custom saved provider: select its model
  $ clawdi deploy --provider <saved-provider-id> --model <id> --compute basic --request-id <uuid> --yes --json
  $ clawdi deploy --compute performance --term 12 --payment wallet --request-id <uuid> --yes --json
  $ clawdi deploy --compute performance --payment card --request-id <uuid> --yes --json

Card payment uses secure checkout in your browser. Reuse --request-id to recover
the same deploy attempt. Every non-interactive deploy requires it before
any create or checkout mutation. No provider secrets are accepted as flags.`,
		)
		.action(async (opts) => {
			const { deployCommand } = await import("../../commands/deploy.js");
			await deployCommand(opts);
		});
}
