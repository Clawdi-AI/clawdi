import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalJson } from "../lib/session-events";
import { prepareSessionUpload } from "../lib/session-upload";
import type { SessionModule } from "./base";

// Captured before production edits from origin/main @ 9db534992.
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
	}
}
