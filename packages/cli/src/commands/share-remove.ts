/**
 * `clawdi share remove <scope-id>` — drop a shared scope from
 * this device. Local-only; the membership (if upgraded) and any
 * still-valid share-link rows on the server are untouched.
 *
 * Adapter-aware folder cleanup: uses the `last_seen_skill_keys`
 * the daemon recorded most recently for this token, then asks
 * each registered adapter where THIS shared skill key would
 * have landed and removes those folders precisely. Suffix-only
 * deletion (`__<owner-handle>`) would erase content from OTHER
 * shared scopes from the same owner — same suffix, different
 * scopes — per spec § 11.1.
 */

import { rmSync } from "node:fs";

import chalk from "chalk";

import { allAdapterEntries } from "../adapters/registry";
import { findToken, removeToken } from "../share/tokens";

export function shareRemoveCommand(scopeId: string): void {
	const token = findToken(scopeId);
	if (!token) {
		console.error(chalk.red(`No local share found for scope ${scopeId}.`));
		console.error(`Run \`clawdi share list\` to see what's accepted here.`);
		process.exitCode = 1;
		return;
	}

	const skillKeys = token.last_seen_skill_keys ?? [];
	let removed = 0;
	for (const entry of allAdapterEntries()) {
		const adapter = entry.create();
		for (const key of skillKeys) {
			const path = adapter.getSharedSkillPath(key, token.owner_handle);
			try {
				rmSync(path, { recursive: true, force: true });
				removed++;
			} catch {
				// Permission / busy / doesn't-exist — best-effort.
			}
		}
	}
	removeToken(scopeId);

	console.log(
		`Removed share for scope ${chalk.bold(token.scope_name)} ` + chalk.gray(`(${scopeId}).`),
	);
	if (removed > 0) {
		console.log(chalk.gray(`Deleted ${removed} local skill folder${removed === 1 ? "" : "s"}.`));
	} else if (skillKeys.length === 0) {
		console.log(
			chalk.yellow(
				"(No skill list cached locally — folders may remain; " +
					"daemon will clean them on next sweep.)",
			),
		);
	}
}
