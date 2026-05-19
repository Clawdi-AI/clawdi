import { existsSync, readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import {
	type ResolveReferenceOptions,
	replaceResolvedReferences,
	resolveReferenceMap,
	scanClawdiReferences,
} from "../lib/secret-references";

export interface InjectOptions extends ResolveReferenceOptions {
	in?: string;
	out?: string;
	force?: boolean;
}

export async function injectCommand(opts: InjectOptions = {}): Promise<void> {
	try {
		const inputPath = opts.in ?? "-";
		const outputPath = opts.out ?? "-";
		if (outputPath !== "-" && existsSync(outputPath) && !opts.force) {
			console.error(chalk.red(`Refusing to overwrite ${outputPath}. Pass --force to replace it.`));
			process.exitCode = 1;
			return;
		}

		const input = await readInput(inputPath);
		const refs = scanClawdiReferences(input);
		const resolved = await resolveReferenceMap(refs, opts);
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

async function readInput(path: string): Promise<string> {
	if (path === "-") {
		return await new Response(Bun.stdin.stream()).text();
	}
	return readFileSync(path, "utf8");
}
