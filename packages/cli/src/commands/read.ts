import chalk from "chalk";
import {
	type ResolveReferenceOptions,
	resolveClawdiReference,
	type VaultReferenceHit,
} from "../lib/secret-references";

export async function readCommand(
	reference: string,
	opts: ResolveReferenceOptions & { json?: boolean } = {},
): Promise<void> {
	try {
		const hit = await resolveClawdiReference(reference, opts);
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

function printDebug(hit: VaultReferenceHit): void {
	console.error(chalk.gray(`from ${hit.source_alias}`));
	if (!hit.precedence) return;
	console.error(chalk.gray("searched:"));
	for (const entry of hit.precedence) {
		console.error(chalk.gray(`  ${entry.alias} ${entry.reason}`));
	}
}
