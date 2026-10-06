import { expect, test } from "bun:test";
import type { SessionWithActivitiesResource } from "@clerk/expo/types";
import { readDeviceSessions } from "@/platform/auth/device-sessions";

function resource(id: string): SessionWithActivitiesResource {
	return {
		id,
		pathRoot: "/me/sessions",
		status: "active",
		actor: null,
		expireAt: new Date(),
		abandonAt: new Date(),
		lastActiveAt: new Date(),
		latestActivity: { id: "activity" },
		async reload() {
			return this;
		},
		async revoke() {
			this.status = "revoked";
			return this;
		},
	};
}

test("refresh reads rebuilt user instead of a cached inventory", async () => {
	const old = { id: "user", getSessions: async () => [resource("stale")] };
	const fresh = { id: "user", getSessions: async () => [resource("current"), resource("other")] };
	const client: Parameters<typeof readDeviceSessions>[0] = {
		sessions: [{ id: "current", status: "active", user: old }],
		reload: async () => ({ sessions: [{ id: "current", status: "active", user: fresh }] }),
	};
	expect(
		(await readDeviceSessions(client, "user", "current", () => true)).map((s) => s.id),
	).toEqual(["current", "other"]);
	client.reload = async () => client;
	await expect(readDeviceSessions(client, "user", "current", () => true)).rejects.toThrow(
		"Fresh account",
	);
});

test("empty, wrong-account and missing-current inventories fail closed", async () => {
	for (const [userId, rows] of [
		["user", []],
		["other", [resource("current")]],
		["user", [resource("other")]],
	] as const) {
		const client: Parameters<typeof readDeviceSessions>[0] = {
			sessions: [],
			reload: async () => ({
				sessions: [
					{
						id: "current",
						status: "active",
						user: { id: userId, getSessions: async () => [...rows] },
					},
				],
			}),
		};
		await expect(readDeviceSessions(client, "user", "current", () => true)).rejects.toThrow();
	}
});

test("account retirement after client refresh prevents inventory request", async () => {
	let active = true;
	let calls = 0;
	const client: Parameters<typeof readDeviceSessions>[0] = {
		sessions: [],
		reload: async () => {
			active = false;
			return {
				sessions: [
					{
						id: "current",
						status: "active",
						user: {
							id: "user",
							getSessions: async () => {
								calls++;
								return [resource("current")];
							},
						},
					},
				],
			};
		},
	};
	await expect(readDeviceSessions(client, "user", "current", () => active)).rejects.toThrow(
		"retired",
	);
	expect(calls).toBe(0);
});

test("late inventory and duplicate session identities are rejected", async () => {
	let active = true;
	const user = {
		id: "user",
		getSessions: async () => {
			active = false;
			return [resource("current")];
		},
	};
	const client: Parameters<typeof readDeviceSessions>[0] = {
		sessions: [],
		reload: async () => ({ sessions: [{ id: "current", status: "active", user }] }),
	};
	await expect(readDeviceSessions(client, "user", "current", () => active)).rejects.toThrow(
		"retired",
	);
	user.getSessions = async () => [resource("current"), resource("current")];
	await expect(readDeviceSessions(client, "user", "current", () => true)).rejects.toThrow(
		"Incomplete",
	);
});
