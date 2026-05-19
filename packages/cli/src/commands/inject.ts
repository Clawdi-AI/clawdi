import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { applyLinkedProjectContext } from "../lib/reference-context";
import {
	type ClawdiReferenceUse,
	previewReferenceMap,
	type ResolveReferenceOptions,
	replaceResolvedReferences,
	resolveReferenceMap,
	scanClawdiReferences,
	scanClawdiReferenceUses,
	type VaultReferencePreview,
} from "../lib/secret-references";

export interface InjectOptions extends ResolveReferenceOptions {
	in?: string;
	out?: string;
	force?: boolean;
	projectFolder?: boolean;
	dryRun?: boolean;
}

export async function injectCommand(opts: InjectOptions = {}): Promise<void> {
	try {
		const inputPath = opts.in ?? "-";
		const outputPath = opts.out ?? "-";
		if (!opts.dryRun && outputPath !== "-" && existsSync(outputPath) && !opts.force) {
			console.error(chalk.red(`Refusing to overwrite ${outputPath}. Pass --force to replace it.`));
			process.exitCode = 1;
			return;
		}

		const input = await readInput(inputPath);
		const uses = scanClawdiReferenceUses(input);
		const refs = scanClawdiReferences(input);
		if (opts.dryRun) {
			const resolved = await previewReferenceMap(refs, applyLinkedProjectContext(opts));
			printDryRunPlan("inject", resolved, uses, input);
			return;
		}
		const resolved = await resolveReferenceMap(refs, applyLinkedProjectContext(opts));
		const output = replaceResolvedReferences(input, resolved);

		if (outputPath === "-") {
			process.stdout.write(output);
		} else {
			writeFileSync(outputPath, output, { mode: 0o600 });
			chmodSync(outputPath, 0o600);
		}

		const summary = `Resolved ${resolved.size} clawdi reference${resolved.size === 1 ? "" : "s"}`;
		console.error(chalk.green(`✓ ${summary}`));
		for (const hit of resolved.values()) {
			console.error(chalk.gray(`  ${formatResolvedUse(hit, uses, input)}`));
		}
	} catch (e) {
		console.error(chalk.red(e instanceof Error ? e.message : String(e)));
		process.exitCode = 1;
	}
}

function printDryRunPlan(
	command: string,
	resolved: Map<string, VaultReferencePreview>,
	uses: ClawdiReferenceUse[],
	input: string,
): void {
	if (resolved.size === 0) {
		console.error(chalk.gray(`Dry run: no clawdi references found for ${command}.`));
		return;
	}
	console.error(
		chalk.green(
			`Dry run: would resolve ${resolved.size} clawdi reference${resolved.size === 1 ? "" : "s"} for ${command}.`,
		),
	);
	for (const hit of resolved.values()) {
		console.error(chalk.gray(`  ${formatResolvedUse(hit, uses, input)}`));
	}
}

function formatResolvedUse(
	hit: VaultReferencePreview,
	uses: ClawdiReferenceUse[],
	input: string,
): string {
	const labels = describeUses(
		uses.filter((use) => use.ref.raw === hit.reference),
		input,
	);
	const prefix = labels.length > 0 ? `${labels.join(", ")}: ` : "";
	const path = [hit.vault_slug, hit.section, hit.item_name].filter(Boolean).join("/");
	const suffix = path ? ` ${path}` : "";
	return `${prefix}${hit.reference} -> ${hit.source_alias}${suffix} (redacted)`;
}

function describeUses(uses: ClawdiReferenceUse[], input: string): string[] {
	const lines = input.split(/\r?\n/);
	const labels: string[] = [];
	const seen = new Set<string>();
	for (const use of uses) {
		const line = lines[use.line - 1] ?? "";
		const label = describeLine(line, use.line);
		if (seen.has(label)) continue;
		seen.add(label);
		labels.push(label);
	}
	if (labels.length <= 3) return labels;
	return [...labels.slice(0, 3), `+${labels.length - 3} more`];
}

function describeLine(line: string, lineNumber: number): string {
	const dotenv = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
	if (dotenv) return `${dotenv[1]} line ${lineNumber}`;
	const json = line.match(/^\s*"([^"]+)"\s*:/);
	if (json) return `${json[1]} line ${lineNumber}`;
	return `line ${lineNumber}`;
}

async function readInput(path: string): Promise<string> {
	if (path === "-") {
		return await new Response(Bun.stdin.stream()).text();
	}
	return readFileSync(path, "utf8");
}
