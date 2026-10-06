import { expect, test } from "bun:test";
import {
	formatGroupHeaderTime,
	formatToolPayload,
	isSkillExpansion,
	parseSlashCommand,
	sessionHasLaterActivity,
	sessionShareDialogCopy,
} from "./session-transcript";

test("slash command envelopes preserve only remaining readable content", () => {
	expect(
		parseSlashCommand(
			"<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src/*.tsx</command-args>\nCheck the API.",
		),
	).toEqual({ name: "/review", args: "src/*.tsx", remaining: "Check the API." });
	expect(
		parseSlashCommand("<command-name>/review</command-name><command-args> </command-args>"),
	).toEqual({ name: "/review", args: undefined, remaining: "" });
	expect(parseSlashCommand("Ordinary <code>input</code>")).toBeNull();
	expect(isSkillExpansion("\n Base directory for this skill: /tmp/skill")).toBe(true);
	expect(isSkillExpansion("Discuss Base directory for this skill:")).toBe(false);
});
test("tool payloads remain readable when they are not JSON", () => {
	expect(formatToolPayload('{"files":["a.ts","b.ts"]}')).toBe(
		'{\n  "files": [\n    "a.ts",\n    "b.ts"\n  ]\n}',
	);
	expect(formatToolPayload("partial log\n{broken")).toBe("partial log\n{broken");
});
test("metadata hides redundant activity stamps and malformed group timestamps", () => {
	expect(sessionHasLaterActivity("2026-10-05T12:00:00Z", "2026-10-05T12:05:00Z")).toBe(false);
	expect(sessionHasLaterActivity("2026-10-05T12:00:00Z", "2026-10-05T12:05:01Z")).toBe(true);
	expect(formatGroupHeaderTime("invalid")).toBe("");
	expect(sessionShareDialogCopy({ scope: "response", position: 2 }).title).toBe(
		"Share this response",
	);
});
