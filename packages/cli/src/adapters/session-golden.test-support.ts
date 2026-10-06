import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../lib/session-events";
import { prepareSessionUpload } from "../lib/session-upload";
import type { SessionModule } from "./base";
import { SESSION_PROJECTION_REVISION } from "./rich-event-mapping";

// Released digests are append-only. Updating a golden's projected bytes requires
// a new SESSION_PROJECTION_REVISION entry, even if its expected fixture changes.
const projectionDigests: Record<string, Record<string, string>> = JSON.parse(
	readFileSync(
		new URL("../../tests/fixtures/session-projection-revisions.json", import.meta.url),
		"utf8",
	),
);

export function assertProjectionGolden(fixture: string, projected: unknown): void {
	const digest = createHash("sha256").update(canonicalJson(projected), "ascii").digest("hex");
	expect(digest, "Projected bytes changed: bump SESSION_PROJECTION_REVISION").toBe(
		projectionDigests[SESSION_PROJECTION_REVISION]?.[fixture],
	);
}

// Adapter fixtures are checked against the current projection revision below.
const goldens: Record<
	string,
	Array<{ id: string; eventNdjson: string; localHash: string; sourceRevision: string | undefined }>
> = JSON.parse(
	readFileSync(
		new URL("../../tests/fixtures/adapter-session-goldens.json", import.meta.url),
		"utf8",
	),
);

export async function assertSessionGolden(fixture: string, module: SessionModule): Promise<void> {
	const protocol = await module.contentProtocol();
	for (const streaming of [false, true]) {
		const { sessions } = await module.collect(
			{ kind: "complete" },
			{ streaming, signal: new AbortController().signal },
		);
		expect(sessions.length).toBeGreaterThan(0);
		const actual = [];
		for (const session of sessions) {
			const plan = await prepareSessionUpload(session, protocol);
			let eventNdjson = "";
			for await (const event of plan.readEvents?.() ?? plan.events ?? [])
				eventNdjson += `${canonicalJson(event)}\n`;
			actual.push({
				id: session.localSessionId,
				eventNdjson,
				localHash: plan.localHash,
				sourceRevision: session.sourceRevision,
			});
		}
		actual.sort((a, b) => a.id.localeCompare(b.id));
		expect(actual).toEqual(goldens[fixture]);
		assertProjectionGolden(
			fixture,
			actual.map(({ sourceRevision: _revision, ...projected }) => projected),
		);
	}
}
