/**
 * Eager-pull helper used by every "accept a shared scope" surface
 * (inbox accept URL, inbox accept invitation, email-invitation
 * accept). Pre-extraction this lived in multiple accept paths in
 * subtly different shapes; this helper keeps eager pulls and local
 * share-token updates consistent.
 *
 * Shape:
 *   1. Page through /api/skills?scope_id=<x> to enumerate active
 *      skills the caller can read on that scope.
 *   2. For each skill: download the tarball and write it to every
 *      registered adapter (claude-code, codex, openclaw, hermes) so
 *      the agent sees the shared content immediately instead of
 *      waiting for the daemon's reconcile sweep.
 *   3. If a local share-token row exists for this scope_id (anon
 *      redeem path), stamp it with `upgraded_at` and the observed
 *      skill_key set — used by `inbox forget` for precise cleanup
 *      later. Conditional, so the email-invitation path (which has
 *      no token row) is a no-op here.
 *
 * Per-skill / per-adapter failures are tolerated (silent skip) so a
 * single bad row doesn't abort the rest of the pull.
 */

import { allAdapterEntries } from "../adapters/registry";
import { addToken, listTokens } from "./tokens";

interface SkillSummary {
	skill_key: string;
	scope_id?: string | null;
	is_active?: boolean;
}

export async function pullSharedSkills(
	apiUrl: string,
	bearer: string,
	scopeId: string,
	ownerHandle: string,
): Promise<number> {
	const PAGE_SIZE = 200;
	const items: SkillSummary[] = [];
	let page = 1;
	while (true) {
		const url = new URL(`${apiUrl}/api/skills`);
		url.searchParams.set("scope_id", scopeId);
		url.searchParams.set("page", String(page));
		url.searchParams.set("page_size", String(PAGE_SIZE));
		const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
		if (!r.ok) throw new Error(`Skill listing failed: HTTP ${r.status}`);
		const body = (await r.json()) as { items: SkillSummary[] };
		items.push(...body.items);
		if (body.items.length < PAGE_SIZE) break;
		page += 1;
		if (page > 50) break;
	}
	const active = items.filter((s) => s.is_active !== false);
	if (active.length === 0) return 0;
	const adapters = allAdapterEntries().map((e) => e.create());

	// Parallel per-skill download — N independent round trips fan out
	// concurrently; per-skill adapter writes also fan out per skill.
	const dlResults = await Promise.all(
		active.map(async (skill): Promise<string | null> => {
			const dlUrl = `${apiUrl}/api/projects/${encodeURIComponent(scopeId)}/skills/${encodeURIComponent(skill.skill_key)}/download`;
			const dl = await fetch(dlUrl, { headers: { Authorization: `Bearer ${bearer}` } });
			if (!dl.ok) return null;
			const buf = Buffer.from(await dl.arrayBuffer());
			await Promise.all(
				adapters.map((adapter) =>
					adapter.writeSharedSkillArchive(skill.skill_key, ownerHandle, buf).catch(() => {}),
				),
			);
			return skill.skill_key;
		}),
	);
	const seenKeys = dlResults.filter((k): k is string => k !== null);

	// Stamp the local share-token row, if one exists for this scope.
	// Anon redeem path → upgraded transition runs through here; the
	// email-invitation accept path has no token row, so this is a no-op
	// for that surface.
	const existingToken = listTokens().find((t) => t.scope_id === scopeId);
	if (existingToken) {
		addToken({
			...existingToken,
			upgraded_at: new Date().toISOString(),
			last_seen_skill_keys: seenKeys,
		});
	}
	return seenKeys.length;
}
