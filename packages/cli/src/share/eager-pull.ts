/**
 * Eager-pull helper used by every "accept a shared project" surface
 * (inbox accept URL, inbox accept invitation, email-invitation
 * accept). Pre-extraction this lived in multiple accept paths in
 * subtly different shapes; this helper keeps eager pulls and local
 * share-token updates consistent.
 *
 * Shape:
 *   1. Page through /api/skills?project_id=<x> to enumerate active
 *      skills the caller can read on that project.
 *   2. For each skill: download the tarball and write it to every
 *      registered adapter (claude-code, codex, openclaw, hermes) so
 *      the agent sees the shared content immediately instead of
 *      waiting for the daemon's reconcile sweep.
 *   3. If a local share-token row exists for this project_id (anon
 *      redeem path), stamp it with `upgraded_at` and the observed
 *      skill_key set — used by `inbox forget` for precise cleanup
 *      later. Conditional, so the email-invitation path (which has
 *      no token row) is a no-op here.
 *
 * Per-skill / per-adapter failures are tolerated (silent skip) so a
 * single bad row doesn't abort the rest of the pull.
 */

import { allAdapterEntries } from "../adapters/registry";
import { readJson } from "../lib/api-client";
import { isValidSkillKey } from "../lib/skill-key";
import { addToken, listTokens } from "./tokens";

interface SkillSummary {
	skill_key: string;
	project_id?: string | null;
	is_active?: boolean;
}

export async function pullSharedSkills(
	apiUrl: string,
	bearer: string,
	projectId: string,
	ownerHandle: string,
): Promise<number> {
	const PAGE_SIZE = 200;
	const items: SkillSummary[] = [];
	let page = 1;
	while (true) {
		const url = new URL(`${apiUrl}/api/skills`);
		url.searchParams.set("project_id", projectId);
		url.searchParams.set("page", String(page));
		url.searchParams.set("page_size", String(PAGE_SIZE));
		const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
		if (!r.ok) throw new Error(`Skill listing failed: HTTP ${r.status}`);
		const body = await readJson<{ items: SkillSummary[] }>(r, "/api/skills");
		items.push(...body.items);
		if (body.items.length < PAGE_SIZE) break;
		page += 1;
		if (page > 50) break;
	}
	const active = items.filter((s) => s.is_active !== false && isValidSkillKey(s.skill_key));
	if (active.length === 0) return 0;
	const adapters = allAdapterEntries().map((e) => e.create());

	// Parallel per-skill download — N independent round trips fan out
	// concurrently; per-skill adapter writes also fan out per skill.
	const dlResults = await Promise.all(
		active.map(async (skill): Promise<string | null> => {
			const dlUrl = `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(skill.skill_key)}/download`;
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

	// Stamp the local share-token row, if one exists for this project.
	// Anon redeem path → upgraded transition runs through here; the
	// email-invitation accept path has no token row, so this is a no-op
	// for that surface.
	const existingToken = listTokens().find((t) => t.project_id === projectId);
	if (existingToken) {
		addToken({
			...existingToken,
			upgraded_at: new Date().toISOString(),
			last_seen_skill_keys: seenKeys,
		});
	}
	return seenKeys.length;
}
