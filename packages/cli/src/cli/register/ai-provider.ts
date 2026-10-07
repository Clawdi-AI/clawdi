import type { Command } from "commander";
import { parsePositiveInteger } from "../../lib/cli-options.js";
import { collectValues } from "../option-values.js";

export function registerAiProvider(program: Command): void {
	const aiProviderCmd = program.command("ai-provider").description("Manage AI providers");

	aiProviderCmd
		.command("list")
		.description("List Cloud and local AI providers")
		.addHelpText("after", "\nExample:\n  $ clawdi ai-provider list --json")
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			const { aiProviderListCommand } = await import("../../commands/ai-provider.js");
			await aiProviderListCommand(opts);
		});

	aiProviderCmd
		.command("add <provider-id>")
		.description("Add an AI provider to the local provider catalog")
		.requiredOption("--type <type>", "Provider type")
		.option("--label <label>", "Display label")
		.option("--base-url <url>", "Provider base URL")
		.option("--default-model <model>", "Model id to add to the provider catalog")
		.option("--api-mode <mode>", "Provider API mode")
		.requiredOption(
			"--auth <auth>",
			"Auth: env:<NAME>, clawdi://..., agent:codex/<profile>, or none",
		)
		.option("--agent-env <name>", "Env var name the target agent process should read")
		.option(
			"--capability <name>",
			"Capability to mark true (repeatable or comma-separated)",
			collectValues,
			[],
		)
		.option("--set-default", "Set as the default chat provider")
		.option("--replace", "Replace an existing provider with the same id")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  $ clawdi ai-provider add openai-main --type openai --default-model gpt-5.2 --auth env:OPENAI_API_KEY
  $ clawdi ai-provider add local --type custom_openai_compatible --base-url http://127.0.0.1:1234/v1 --api-mode openai_chat --auth none`,
		)
		.action(async (providerId: string, opts) => {
			const { aiProviderAddCommand } = await import("../../commands/ai-provider.js");
			await aiProviderAddCommand(providerId, opts);
		});

	aiProviderCmd
		.command("edit <provider-id>")
		.description("Edit a Cloud or local AI provider")
		.addHelpText("after", "\nExample:\n  $ clawdi ai-provider edit openai-main --label Main --json")
		.option("--type <type>", "Provider type")
		.option("--label <label>", "Display label")
		.option("--base-url <url>", "Provider base URL")
		.option("--default-model <model>", "Model id to add to the provider catalog")
		.option("--api-mode <mode>", "Provider API mode")
		.option("--auth <auth>", "Auth: env:<NAME>, clawdi://..., agent:codex/<profile>, or none")
		.option("--agent-env <name>", "Env var name the target agent process should read")
		.option(
			"--capability <name>",
			"Capability to mark true (repeatable or comma-separated)",
			collectValues,
			[],
		)
		.option("--set-default", "Set as the default chat provider")
		.option("--json", "Output as JSON")
		.action(async (providerId: string, opts) => {
			const { aiProviderEditCommand } = await import("../../commands/ai-provider.js");
			await aiProviderEditCommand(providerId, opts);
		});

	aiProviderCmd
		.command("remove <provider-id>")
		.alias("rm")
		.description("Remove an AI provider")
		.option("--force", "Remove even if defaults reference it")
		.option("-y, --yes", "Skip the interactive confirmation prompt")
		.option("--json", "Output as JSON")
		.addHelpText("after", "\nExample:\n  $ clawdi ai-provider remove <provider-id> --yes")
		.action(async (providerId: string, opts) => {
			const { aiProviderRemoveCommand } = await import("../../commands/ai-provider.js");
			await aiProviderRemoveCommand(providerId, opts);
		});

	aiProviderCmd
		.command("validate [provider-id]")
		.description("Validate the AI provider catalog")
		.option("--allow-no-auth-public", "Allow no-auth providers on public URLs")
		.option("--json", "Output as JSON")
		.action(async (providerId: string | undefined, opts) => {
			const { aiProviderValidateCommand } = await import("../../commands/ai-provider.js");
			await aiProviderValidateCommand(providerId, opts);
		});

	aiProviderCmd
		.command("test <provider-id>")
		.description("Check provider config and auth availability")
		.option(
			"--model <model>",
			"Model to validate against when a provider-specific probe supports it",
		)
		.option("--timeout <seconds>", "Provider probe timeout in seconds", parsePositiveInteger, 10)
		.option("--live", "Also run a direct provider metadata probe")
		.option("--probe", "Deprecated alias for --live")
		.option("--no-probe", "Compatibility flag; live probes are disabled unless --live is passed")
		.option("--json", "Output as JSON")
		.action(async (providerId: string, opts) => {
			const { aiProviderTestCommand } = await import("../../commands/ai-provider.js");
			await aiProviderTestCommand(providerId, opts);
		});

	aiProviderCmd
		.command("connect <provider-id>")
		.description("Connect provider auth through an OAuth/device-code flow")
		.option("--method <method>", "Connect method", "oauth")
		.option("--tool <tool>", "Tool sign-in profile to connect, currently codex")
		.option("--callback <mode>", "OAuth callback mode: loopback or manual")
		.option("--redirect-uri <uri>", "Override OAuth redirect URI for manual callback mode")
		.option(
			"--timeout <seconds>",
			"Seconds to wait for loopback callback",
			parsePositiveInteger,
			600,
		)
		.option("--no-open", "Do not open the browser automatically")
		.option("--dry-run", "Show the OAuth start request without running it")
		.option("--json", "Output as JSON")
		.action(async (providerId: string, opts) => {
			const { aiProviderConnectCommand } = await import("../../commands/ai-provider.js");
			await aiProviderConnectCommand(providerId, opts);
		});

	aiProviderCmd
		.command("complete-oauth <provider-id>")
		.description("Complete AI provider OAuth with a pasted redirect URL or code/state")
		.option("--redirect-url <url>", "Full OAuth redirect URL containing code and state")
		.option("--code <code>", "OAuth authorization code")
		.option("--state <state>", "OAuth state returned by connect")
		.option("--redirect-uri <uri>", "Redirect URI used for the OAuth start request")
		.option("--json", "Output as JSON")
		.action(async (providerId: string, opts) => {
			const { aiProviderCompleteOAuthCommand } = await import("../../commands/ai-provider.js");
			await aiProviderCompleteOAuthCommand(providerId, opts);
		});

	aiProviderCmd
		.command("import-auth <provider-id>")
		.description("Import a local auth profile and bind it to an AI provider")
		.option("--tool <tool>", "Tool profile to import, currently codex")
		.option("--profile <name>", "Profile name", "default")
		.option("--source <source>", "Credential source: file or keychain", "file")
		.option("--from <path>", "Credential file to import")
		.option("--to <path>", "Materialization target path to store with the profile")
		.option("--keychain-service <service>", "macOS Keychain service name for --source keychain")
		.option("--keychain-account <account>", "macOS Keychain account name for --source keychain")
		.option("-y, --yes", "Skip confirmation (required in a non-interactive shell)")
		.option("--dry-run", "Show what would be imported without storing anything")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi ai-provider import-auth openai-codex --tool codex --yes",
		)
		.action(async (providerId: string, opts) => {
			const { aiProviderImportAuthCommand } = await import("../../commands/ai-provider.js");
			await aiProviderImportAuthCommand(providerId, opts);
		});

	aiProviderCmd
		.command("export")
		.description("Export provider catalog metadata and refs")
		.option("--out <file>", "Write to a file instead of stdout")
		.option("--include-secrets", "Include encrypted env-backed secrets in the export")
		.option("--secret-passphrase", "Encrypt included secrets with a passphrase from env")
		.option(
			"--secret-passphrase-env <name>",
			"Env var holding the encrypted secret export passphrase",
			"CLAWDI_SECRET_EXPORT_PASSPHRASE",
		)
		.action(async (opts) => {
			const { aiProviderExportCommand } = await import("../../commands/ai-provider.js");
			await aiProviderExportCommand(opts);
		});

	aiProviderCmd
		.command("import [file]")
		.description("Import and merge a provider catalog file")
		.option("--from-hermes <path>", "Import providers from a Hermes config.yaml")
		.option("--from-openclaw <path>", "Import providers from an OpenClaw projection JSON")
		.option("--import-secrets <target>", "Import encrypted secrets to a target, currently env-file")
		.option("--out <file>", "Output path for --import-secrets env-file")
		.option(
			"--secret-passphrase-env <name>",
			"Env var holding the encrypted secret import passphrase",
			"CLAWDI_SECRET_EXPORT_PASSPHRASE",
		)
		.option("--replace", "Replace existing providers with matching ids")
		.option("--json", "Output as JSON")
		.action(async (file: string | undefined, opts) => {
			const { aiProviderImportCommand } = await import("../../commands/ai-provider.js");
			await aiProviderImportCommand(file, opts);
		});
}
