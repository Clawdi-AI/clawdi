/**
 * `clawdi share list` — show every accepted share-link on this
 * device.
 *
 * Local-only command; no network call. The on-disk state is
 * authoritative for what skills the agent should be loading,
 * since shared skill content sits under each adapter's skills
 * root and the daemon's job is purely keeping that in sync.
 */

import chalk from "chalk";

import { listTokens } from "../share/tokens";

export function shareListCommand(): void {
	const tokens = listTokens();
	if (tokens.length === 0) {
		console.log("No shared scopes accepted on this device.");
		console.log();
		console.log("Got a share link from someone? Run:");
		console.log(chalk.cyan("  clawdi share accept <url>"));
		return;
	}

	console.log(`Shared scopes on this device (${tokens.length}):`);
	console.log();
	for (const t of tokens) {
		const upgradedTag = t.upgraded_at ? chalk.green(" ✓ member") : "";
		console.log(
			`  ${chalk.bold(t.scope_name)}  ${chalk.gray(`— from ${t.owner_display} (@${t.owner_handle})`)}${upgradedTag}`,
		);
		console.log(`    ${chalk.gray("scope_id:")} ${t.scope_id}`);
		console.log(`    ${chalk.gray("accepted:")} ${t.redeemed_at}`);
		if (t.last_seen_skill_keys && t.last_seen_skill_keys.length > 0) {
			console.log(`    ${chalk.gray("skills:")} ${t.last_seen_skill_keys.join(", ")}`);
		}
		console.log();
	}

	const anon = tokens.filter((t) => !t.upgraded_at).length;
	if (anon > 0) {
		console.log(
			chalk.dim(
				`${anon} share${anon === 1 ? "" : "s"} not yet upgraded to permanent ` +
					`membership — sign in with ${chalk.bold("clawdi auth login")} to convert them.`,
			),
		);
	}
}
