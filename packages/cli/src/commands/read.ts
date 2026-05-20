import chalk from "chalk";
import { applyLinkedProjectContext } from "../lib/reference-context";
import {
	previewClawdiReference,
	type ResolveReferenceOptions,
	resolveClawdiReference,
	type VaultReferenceHit,
	type VaultReferencePreview,
} from "../lib/secret-references";

export async function readCommand(
	reference: string,
	opts: ResolveReferenceOptions & {
		json?: boolean;
		projectFolder?: boolean;
		dryRun?: boolean;
	} = {},
): Promise<void> {
	try {
		if (opts.dryRun) {
			const hit = await previewClawdiReference(reference, applyLinkedProjectContext(opts));
			if (opts.json) {
				console.log(JSON.stringify(hit, null, 2));
				return;
			}
			console.log(chalk.green(`✓ Reference resolves from ${hit.source_alias} (redacted)`));
			if (opts.debug) printDebug(hit);
			return;
		}
		const hit = await resolveClawdiReference(reference, applyLinkedProjectContext(opts));
		if (opts.json) {
			console.log(JSON.stringify(hit, null, 2));
			return;
		}
		console.log(hit.value);
		if (opts.debug) printDebug(hit);
	} catch (e) {
		console.error(chalk.red(e instanceof Error ? e.message : String(e)));
		process.exitCode = 1;
	}
}

function printDebug(hit: VaultReferenceHit | VaultReferencePreview): void {
	console.error(chalk.gray(`from ${hit.source_alias}`));
	if (!hit.precedence) return;
	console.error(chalk.gray("searched:"));
	for (const entry of hit.precedence) {
		console.error(chalk.gray(`  ${entry.alias} ${entry.reason}`));
	}
}
