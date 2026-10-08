import type { Option } from "@clack/prompts";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { isInteractive } from "./tty";

export type SelectOption<T extends string> = { value: T; label: string; hint?: string };

function toClackOptions<T extends string>(options: SelectOption<T>[]): Option<T>[] {
	// `Option<T>` is a conditional that doesn't reduce when T is a generic
	// constrained to `string`, so the literal needs an explicit cast.
	return options.map((o) => {
		const base = { value: o.value, label: o.label, ...(o.hint ? { hint: o.hint } : {}) };
		return base as Option<T>;
	});
}

export async function confirmOrRequireYes(
	message: string,
	opts: { yes?: boolean; action: string },
): Promise<boolean> {
	if (opts.yes) return true;
	if (!isInteractive()) {
		throw new Error(
			`Confirmation required to ${opts.action}. Re-run with --yes in a non-interactive shell.`,
		);
	}
	const result = await p.confirm({ message, output: process.stderr });
	if (p.isCancel(result) || !result) {
		p.cancel("Cancelled.", { output: process.stderr });
		return false;
	}
	return result;
}

export async function askMulti<T extends string>(
	message: string,
	options: SelectOption<T>[],
	defaultSelected?: T[],
): Promise<T[] | null> {
	if (!isInteractive()) {
		return defaultSelected ?? options.map((o) => o.value);
	}
	const initial = defaultSelected ?? options.map((o) => o.value);
	const result = await p.multiselect<T>({
		output: process.stderr,
		message,
		options: toClackOptions(options),
		initialValues: initial,
		required: false,
	});
	if (p.isCancel(result)) return null;
	return result;
}

/**
 * Resolve a `--modules` value against the allowed module names. Returns
 * the full list when `input` is undefined, the parsed subset otherwise,
 * or `null` on an unknown name (after printing the reason). Never
 * returns an empty array.
 */
export function parseModules(
	input: string | undefined,
	available: readonly string[],
): string[] | null {
	if (!input) return [...available];
	const chosen = input
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const valid = new Set(available);
	const invalid = chosen.filter((c) => !valid.has(c));
	if (invalid.length > 0) {
		console.error(chalk.red(`Unknown module(s): ${invalid.join(", ")}`));
		console.error(chalk.gray(`  Valid: ${available.join(", ")}`));
		return null;
	}
	if (chosen.length === 0) return null;
	return chosen;
}
