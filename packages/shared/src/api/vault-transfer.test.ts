import { expect, test } from "bun:test";
import { transferVaultKeys } from "./vault-transfer";

test("transfer groups sections, deduplicates names and respects request limits", async () => {
	const calls: [string, string[]][] = [];
	const keys = Array.from({ length: 201 }, (_, i) => ({ section: "(default)", name: `K${i}` }));
	const result = await transferVaultKeys(
		[...keys, { section: "", name: "K0" }, { section: "prod", name: "legacy/K0" }],
		"copy",
		{
			copy: async (section, fields) => {
				calls.push([section, fields]);
				return { status: "ok", copied: fields.length };
			},
			remove: async () => {
				throw new Error("Copy must not delete");
			},
		},
	);
	expect(calls.map(([section, fields]) => [section, fields.length])).toEqual([
		["", 150],
		["", 51],
		["prod", 1],
	]);
	expect(calls[2]?.[1]).toEqual(["legacy/K0"]);
	expect(result).toEqual({ copied: 202, failed: [], sourceRemoveFailed: [], interrupted: false });
});

test("partial and unconfirmed copies never authorize deleting source keys", async () => {
	let deletes = 0;
	for (const count of [0, 1, 3, Number.NaN]) {
		const result = await transferVaultKeys(
			[
				{ section: "", name: "A" },
				{ section: "", name: "B" },
			],
			"move",
			{
				copy: async () => ({ status: "ok", copied: count }),
				remove: async () => {
					deletes++;
					return { status: "deleted" };
				},
			},
		);
		expect(result.failed).toHaveLength(2);
	}
	expect(deletes).toBe(0);
});

test("move deletes only confirmed batches and does not retry an unknown copy", async () => {
	const events: string[] = [];
	const result = await transferVaultKeys(
		[
			{ section: "", name: "A" },
			{ section: "prod", name: "B" },
		],
		"move",
		{
			copy: async (section) => {
				events.push(`copy:${section}`);
				if (section === "prod") throw new Error("Connection lost after write");
				return { status: "ok", copied: 1 };
			},
			remove: async (section, fields) => {
				events.push(`delete:${section}:${fields.join(",")}`);
				return { status: "deleted" };
			},
		},
	);
	expect(events).toEqual(["copy:", "delete::A", "copy:prod"]);
	expect(result).toEqual({
		copied: 1,
		failed: ["prod/B"],
		sourceRemoveFailed: [],
		interrupted: false,
	});
});

test("move reports cleanup failure and stops after ownership retires without further mutations", async () => {
	let current = true;
	let deletes = 0;
	const result = await transferVaultKeys(
		[
			{ section: "", name: "A" },
			{ section: "prod", name: "B" },
		],
		"move",
		{
			copy: async () => ({ status: "ok", copied: 1 }),
			remove: async () => {
				deletes++;
				current = false;
				throw new Error("Unknown outcome");
			},
			isCurrent: () => current,
		},
	);
	expect(deletes).toBe(1);
	expect(result).toEqual({
		copied: 1,
		failed: [],
		sourceRemoveFailed: ["(default)/A"],
		interrupted: true,
	});
});

test("invalid selection fails before any operation and a retired copy cannot trigger deletion", async () => {
	let calls = 0;
	const operations = {
		copy: async () => {
			calls++;
			return { status: "ok" as const, copied: 1 };
		},
		remove: async () => {
			calls++;
			return { status: "deleted" as const };
		},
	};
	await expect(
		transferVaultKeys([{ section: "../bad", name: "A" }], "move", operations),
	).rejects.toThrow();
	expect(calls).toBe(0);
	let current = true;
	const result = await transferVaultKeys([{ section: "", name: "A" }], "move", {
		...operations,
		copy: async () => {
			current = false;
			return { status: "ok", copied: 1 };
		},
		isCurrent: () => current,
	});
	expect(calls).toBe(0);
	expect(result.sourceRemoveFailed).toEqual(["(default)/A"]);
	expect(result.interrupted).toBe(true);
});
