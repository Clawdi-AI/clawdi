#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
	.name("clawdi")
	.description("iCloud for AI Agents — sync sessions, skills, vault across agents")
	.version("0.0.1");

program
	.command("login")
	.description("Authenticate with Clawdi Cloud")
	.action(async () => {
		const { login } = await import("./commands/login.js");
		await login();
	});

program
	.command("logout")
	.description("Remove local credentials")
	.action(async () => {
		const { logout } = await import("./commands/login.js");
		await logout();
	});

program
	.command("status")
	.description("Show current auth and sync status")
	.action(async () => {
		const { status } = await import("./commands/status.js");
		await status();
	});

program
	.command("setup")
	.description("Detect agent and register environment")
	.option("--agent <type>", "Agent type (claude_code, codex, openclaw, hermes)")
	.action(async (opts) => {
		const { setup } = await import("./commands/setup.js");
		await setup(opts);
	});

const syncCmd = program.command("sync").description("Sync data with Clawdi Cloud");

syncCmd
	.command("up")
	.description("Push local data to cloud")
	.option("--modules <modules>", "Comma-separated: sessions,skills,memories")
	.option("--since <date>", "Only sync data after this date")
	.option("--dry-run", "Preview without uploading")
	.action(async (opts) => {
		const { syncUp } = await import("./commands/sync.js");
		await syncUp(opts);
	});

syncCmd
	.command("down")
	.description("Pull cloud data to local")
	.option("--modules <modules>", "Comma-separated: skills,memories")
	.option("--dry-run", "Preview without downloading")
	.action(async (opts) => {
		const { syncDown } = await import("./commands/sync.js");
		await syncDown(opts);
	});

const vaultCmd = program.command("vault").description("Manage secrets");

vaultCmd
	.command("set <key>")
	.description("Store a secret")
	.action(async (key) => {
		const { vaultSet } = await import("./commands/vault.js");
		await vaultSet(key);
	});

vaultCmd
	.command("list")
	.description("List stored keys")
	.action(async () => {
		const { vaultList } = await import("./commands/vault.js");
		await vaultList();
	});

vaultCmd
	.command("import <file>")
	.description("Import from .env file")
	.action(async (file) => {
		const { vaultImport } = await import("./commands/vault.js");
		await vaultImport(file);
	});

program
	.command("run")
	.description("Run a command with vault secrets injected")
	.argument("<command...>", "Command to run")
	.action(async (args) => {
		const { run } = await import("./commands/run.js");
		await run(args);
	});

program.parse();
