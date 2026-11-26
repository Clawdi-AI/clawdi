import { describe, expect, test } from "bun:test";
import { computeOpenClawRealUserActivity } from "./session-activity";

describe("computeOpenClawRealUserActivity", () => {
	test("keeps only timestamped external user input across old and new records", () => {
		const activity = computeOpenClawRealUserActivity(
			[
				{
					role: "user",
					content: "old message",
					timestamp: "2026-07-31T23:59:59.999Z",
				},
				{
					type: "message",
					timestamp: "2026-08-01T00:00:00Z",
					message: { role: "user", content: "hello" },
				},
				{
					role: "assistant",
					content: "reply",
					timestamp: "2026-08-02T00:00:00Z",
				},
				{
					role: "user",
					content: "internal",
					origin: "inter-session",
					timestamp: "2026-08-03T00:00:00Z",
				},
				{
					role: "user",
					content: "[OpenClaw heartbeat poll]",
					timestamp: "2026-08-04T00:00:00Z",
				},
			],
			"agent:main:main",
			undefined,
			Date.parse("2026-08-08T00:00:00Z"),
		);

		expect(activity).toEqual({
			lastUserInputAt: "2026-08-01T00:00:00.000Z",
			recentUserInputCount: 1,
			complete: true,
		});
	});

	test("fails closed when a real user input has no usable timestamp", () => {
		expect(
			computeOpenClawRealUserActivity(
				[{ role: "user", content: [{ type: "image", url: "fixture" }] }],
				"agent:main:main",
			),
		).toEqual({ lastUserInputAt: null, recentUserInputCount: null, complete: false });
	});

	test("treats cron and subagent sessions as internal", () => {
		const record = {
			role: "user",
			content: "generated",
			timestamp: "2026-08-01T00:00:00Z",
		};
		expect(computeOpenClawRealUserActivity([record], "agent:main:cron:daily")).toEqual({
			lastUserInputAt: null,
			recentUserInputCount: 0,
			complete: true,
		});
		expect(computeOpenClawRealUserActivity([record], "subagent:worker")).toEqual({
			lastUserInputAt: null,
			recentUserInputCount: 0,
			complete: true,
		});
		expect(
			computeOpenClawRealUserActivity([record], "agent:main:main", {
				source: "cron",
			}),
		).toEqual({ lastUserInputAt: null, recentUserInputCount: 0, complete: true });
	});
});
