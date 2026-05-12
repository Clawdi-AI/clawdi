import chalk from "chalk";

import { ApiError } from "../lib/api-client";
import { getAuth, getConfig } from "../lib/config";
import { resolveScopeId } from "../lib/scope-resolver";

/**
 * `clawdi scope share <scope> [--label TEXT]` — generate a fresh
 * share link. Prints the full URL ONCE; server stores only the
 * SHA-256 hash + prefix going forward.
 *
 * Default behavior matches the web "Generate link" button:
 *   - Token + URL printed inline (the user can pipe / scroll-back).
 *   - The prefix is what subsequent `clawdi scope share-links`
 *     listings show; the full token is unrecoverable.
 *
 * Errors:
 *   - 409 display_name_required → reminds to run a profile update
 *     (`clawdi auth status` doesn't yet support set-name; web is
 *     the path of least resistance for now).
 *   - 404 → scope not yours / doesn't exist.
 */

interface ShareLinkCreated {
	id: string;
	raw_token: string;
	url: string;
	prefix: string;
	owner_handle: string;
	label: string | null;
	created_at: string;
	expires_at: string | null;
}

export async function scopeShareCommand(scopeArg: string, opts: { label?: string }): Promise<void> {
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		console.error(chalk.red("Not signed in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	const scopeId = await resolveScopeId(apiUrl, auth.apiKey, scopeArg);
	const r = await fetch(`${apiUrl}/api/scopes/${scopeId}/share-links`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ label: opts.label ?? null }),
	});
	if (r.status === 409) {
		const body = (await r.json().catch(() => ({}))) as {
			detail?: { error?: string; message?: string };
		};
		if (body?.detail?.error === "display_name_required") {
			console.error(
				chalk.red(
					"Set a display name on your profile before sharing. " +
						"Recipients see the name — open the web dashboard and update your profile.",
				),
			);
			process.exitCode = 1;
			return;
		}
		console.error(chalk.red(`Couldn't create link: ${body.detail?.message ?? r.status}`));
		process.exitCode = 1;
		return;
	}
	if (!r.ok) {
		throw new ApiError({ status: r.status, body: await r.text(), hint: "" });
	}
	const body = (await r.json()) as ShareLinkCreated;

	console.log();
	console.log(chalk.green("✓") + ` Share link ready`);
	console.log();
	console.log(`  ${chalk.bold(body.url)}`);
	console.log();
	console.log(
		chalk.gray(
			"Save this URL now — only the prefix " + chalk.bold(body.prefix) + " remains visible later.",
		),
	);
	console.log(chalk.gray(`Owner handle: @${body.owner_handle}`));
	if (body.label) console.log(chalk.gray(`Label: ${body.label}`));
	console.log();
	console.log("Recipient runs: " + chalk.cyan(`clawdi share accept ${body.url}`));
}
