import type { Command } from "commander";

export function registerVault(program: Command): void {
	const vaultCmd = program
		.command("vault")
		.description("Manage secrets")
		.addHelpText(
			"after",
			`
Scope:
  Vaults are account-level key bundles. Projects attach to a vault to use the
  same shared key set. set/import update the vault for every attached project.
  rm deletes a key from the vault; detach only removes one project's access.
  Key paths are KEY, vault/KEY, or vault/section/KEY.`,
		);

	vaultCmd
		.command("request <key>")
		.description("Request a secret through the browser without reading its value")
		.option("--project <id-or-slug>", "Target project (default: your default-write project)")
		.option("--wait", "Wait up to five minutes for the secret to be supplied")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExample:\n  $ clawdi vault request api-service/OPENAI_API_KEY --project engineering --wait --json",
		)
		.action(async (id: string, opts) => {
			const { vaultRequest } = await import("../../commands/vault.js");
			await vaultRequest(id, opts);
		});

	vaultCmd
		.command("materialize")
		.alias("pull")
		.description("Bind one vault to a local dotenv file, or pull its saved binding")
		.requiredOption(
			"--out <absolute-path>",
			"Explicit local dotenv target (must be Git-ignored in a repository)",
		)
		.option("--vault <uuid>", "Exact vault identity; required on first pull")
		.option("--project <uuid>", "Exact project attachment; required on first pull")
		.option("--section <name>", "Limit to one section (empty string selects unsectioned keys)")
		.action(async (opts) => {
			const { vaultMaterialize } = await import("../../commands/vault-materialize.js");
			await vaultMaterialize(opts);
		});

	vaultCmd
		.command("set <key>")
		.description("Store a secret")
		.option(
			"-p, --project <id-or-slug>",
			"Target a specific project (default: your default-write project)",
		)
		.option("--value <value>", "Secret value; use --prompt or --stdin to avoid shell history")
		.option("--stdin", "Read the secret value from stdin")
		.option("--prompt", "Prompt for the secret value without echoing input")
		.option("--allow-empty", "Allow storing an empty secret value intentionally")
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi vault set OPENAI_API_KEY --prompt\n  $ clawdi vault set DEPLOY_KEY --project engineering --prompt\n  $ printf 'secret' | clawdi vault set api-service/env/DEPLOY_KEY --stdin",
		)
		.option("--json", "Output as JSON")
		.action(async (key, opts) => {
			const { vaultSet } = await import("../../commands/vault.js");
			await vaultSet(key, {
				...opts,
				project: opts.project,
				value: opts.value,
				stdin: opts.stdin,
				prompt: opts.prompt,
				allowEmpty: opts.allowEmpty,
			});
		});

	vaultCmd
		.command("list")
		.description("List stored keys and exact references")
		.option(
			"-p, --project <id-or-slug>",
			"List vaults in a specific project (default: all visible projects)",
		)
		.option("--json", "Output as JSON")
		.action(async (opts) => {
			const { vaultList } = await import("../../commands/vault.js");
			await vaultList(opts);
		});

	vaultCmd
		.command("import <file>")
		.description("Import from .env file")
		.option("-y, --yes", "Skip confirmation (required in a non-interactive shell)")
		.option("--vault <slug>", "Target vault slug", "default")
		.option("--section <name>", "Target vault section")
		.option(
			"-p, --project <id-or-slug>",
			"Target a specific project (default: your default-write project)",
		)
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi vault import .env.production\n  $ clawdi vault import .env.staging --project engineering --yes\n  $ clawdi vault import --vault prod --section stripe --project engineering --yes .env.stripe",
		)
		.option("--json", "Output as JSON")
		.action(async (file, opts) => {
			const { vaultImport } = await import("../../commands/vault.js");
			await vaultImport(file, {
				...opts,
				project: opts.project,
				section: opts.section,
				vault: opts.vault,
			});
		});

	vaultCmd
		.command("attach <vault>")
		.description("Make an existing vault available in a project")
		.requiredOption("-p, --project <id-or-slug>", "Project that should use this vault")
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi vault attach providers --project redpill-providers",
		)
		.option("--json", "Output as JSON")
		.action(async (vault, opts) => {
			const { vaultAttach } = await import("../../commands/vault.js");
			await vaultAttach(vault, opts);
		});

	vaultCmd
		.command("detach <vault>")
		.description("Remove a project's access to a vault without deleting keys")
		.requiredOption("-p, --project <id-or-slug>", "Project that should stop using this vault")
		.option("-y, --yes", "Confirm detaching the vault")
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi vault detach providers --project env-abc123 --yes\n  $ clawdi vault detach providers --project old-agent --yes",
		)
		.option("--json", "Output as JSON")
		.action(async (vault, opts) => {
			const { vaultDetach } = await import("../../commands/vault.js");
			await vaultDetach(vault, opts);
		});

	vaultCmd
		.command("rm <key>")
		.alias("delete")
		.description("Delete a key from a vault")
		.option(
			"-p, --project <id-or-slug>",
			"Select the project used to locate the vault (default: your default-write project)",
		)
		.option("-y, --yes", "Skip the confirmation prompt")
		.option(
			"--global",
			"Allow deleting a key from a vault attached to multiple projects (affects every project using it)",
		)
		.addHelpText(
			"after",
			"\nExamples:\n  $ clawdi vault rm OPENAI_API_KEY\n  $ clawdi vault delete prod/stripe/SECRET_KEY --project engineering --yes\n  $ clawdi vault rm OPENAI_API_KEY --project engineering --global --yes",
		)
		.option("--json", "Output as JSON")
		.action(async (key, opts) => {
			const { vaultRm } = await import("../../commands/vault.js");
			await vaultRm(key, { ...opts, project: opts.project, yes: opts.yes, global: opts.global });
		});

	vaultCmd
		.command("resolve <key>")
		.description("Resolve one vault key")
		.option(
			"-p, --project <project>",
			"Project to resolve from (default: your default-write project)",
		)
		.option("-a, --agent <agent-id-or-type>", "Resolve through workspace and linked projects")
		.option(
			"--allow-conflicts",
			"Allow first-match wins for workspace and linked-project vault conflicts",
		)
		.option("--debug", "Show project precedence and skipped matches")
		.option("--dry-run", "Check where the key resolves without printing the plaintext value")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ clawdi vault resolve OPENAI_API_KEY                       # default-write project\n" +
				"  $ clawdi vault resolve OPENAI_API_KEY --project personal --debug\n" +
				"  $ clawdi vault resolve OPENAI_API_KEY --agent <agent-id> --debug\n" +
				"  $ clawdi vault resolve OPENAI_API_KEY --agent codex --allow-conflicts --json",
		)
		.action(async (key, opts) => {
			const { vaultResolveCommand } = await import("../../commands/vault-resolve.js");
			await vaultResolveCommand(key, { ...opts, project: opts.project });
		});
}
