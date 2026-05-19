import { existsSync, readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { applyLinkedProjectContext } from "../lib/reference-context";
import {
	previewReferenceMap,
	type ResolveReferenceOptions,
	replaceResolvedReferences,
	resolveReferenceMap,
	scanClawdiReferences,
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
		const refs = scanClawdiReferences(input);
		if (opts.dryRun) {
			const resolved = await previewReferenceMap(refs, applyLinkedProjectContext(opts));
			printDryRunPlan("inject", resolved);
			return;
		}
		const resolved = await resolveReferenceMap(refs, applyLinkedProjectContext(opts));
		const output = replaceResolvedReferences(input, resolved);

		if (outputPath === "-") {
			process.stdout.write(output);
		} else {
			writeFileSync(outputPath, output, { mode: 0o600 });
		}

		const summary = `Resolved ${resolved.size} clawdi reference${resolved.size === 1 ? "" : "s"}`;
		console.error(chalk.green(`✓ ${summary}`));
		for (const hit of resolved.values()) {
			console.error(chalk.gray(`  ${hit.reference} -> ${hit.source_alias} (redacted)`));
		}
	} catch (e) {
		console.error(chalk.red(e instanceof Error ? e.message : String(e)));
		process.exitCode = 1;
	}
}

function printDryRunPlan(command: string, resolved: Map<string, VaultReferencePreview>): void {
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
		console.error(chalk.gray(`  ${hit.reference} -> ${hit.source_alias} (redacted)`));
	}
}

async function readInput(path: string): Promise<string> {
	if (path === "-") {
		return await new Response(Bun.stdin.stream()).text();
	}
	return readFileSync(path, "utf8");
}
