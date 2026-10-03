import { expect, test } from "bun:test";
import type { components } from "./api.generated";
import type { VaultClient } from "./vault-client";
import { prefixGroupsFor, splitVaultKeys, validVaultSplit } from "./vault-split";

const source = { id: "source", slug: "source" };
const keys = (prefix: string) =>
	["A", "B"].map((name) => ({ section: "(default)", name: `${prefix}/${name}` }));
const target = (slug: string): components["schemas"]["VaultCreatedResponse"] => ({
	id: `id-${slug}`,
	slug,
});

test("prefix plans preserve colliding exact prefixes and require explicit distinct destinations", () => {
	const groups = prefixGroupsFor([...keys("app_a"), ...keys("app-a"), ...keys("app_a")]);
	expect(groups).toHaveLength(2);
	expect(groups.map((g) => g.keys.length)).toEqual([2, 2]);
	expect(validVaultSplit(source, groups)).toBe(false);
	expect(
		validVaultSplit(
			source,
			groups.map((g, i) => ({ ...g, slug: `app-${i}` })),
		),
	).toBe(true);
	expect(validVaultSplit(source, [{ prefix: "app/", slug: "source", keys: keys("app") }])).toBe(
		false,
	);
	expect(validVaultSplit(source, [{ prefix: "app/", slug: "app", keys: keys("other") }])).toBe(
		false,
	);
});

test("split keeps exact destination IDs and never deletes a partial-copy group", async () => {
	const calls: unknown[] = [];
	const api: Pick<VaultClient, "create" | "copyItems" | "deleteItems"> = {
		create: async (body) => {
			calls.push(["create", body.slug]);
			return target(body.slug);
		},
		copyItems: async (from, to, body) => {
			calls.push(["copy", from.id, to.id, body]);
			return { status: "ok", copied: to.slug === "app" ? 2 : 1 };
		},
		deleteItems: async (from, body, globalDelete) => {
			calls.push(["delete", from.id, body, globalDelete]);
			return { status: "deleted" };
		},
	};
	const result = await splitVaultKeys(
		source,
		prefixGroupsFor([...keys("app"), ...keys("other")]),
		true,
		api,
	);
	expect(calls).toEqual([
		["create", "app"],
		["copy", "source", "id-app", { section: "", fields: ["app/A", "app/B"], strip_prefix: "app/" }],
		["delete", "source", { section: "", fields: ["app/A", "app/B"] }, true],
		["create", "other"],
		[
			"copy",
			"source",
			"id-other",
			{ section: "", fields: ["other/A", "other/B"], strip_prefix: "other/" },
		],
	]);
	expect(result.groups.map((g) => g.status)).toEqual(["complete", "partial"]);
	expect(result.groups[1]?.target).toEqual({ id: "id-other", slug: "other" });
});

test("invalid plans do no work; failed strict creation is not retried or reused", async () => {
	let creates = 0;
	let copies = 0;
	const api: Pick<VaultClient, "create" | "copyItems" | "deleteItems"> = {
		create: async () => {
			creates++;
			throw new Error("Existing destination");
		},
		copyItems: async () => {
			copies++;
			return { status: "ok", copied: 2 };
		},
		deleteItems: async () => {
			throw new Error("Must not delete");
		},
	};
	await expect(
		splitVaultKeys(source, prefixGroupsFor([...keys("app_a"), ...keys("app-a")]), true, api),
	).rejects.toThrow();
	expect(creates).toBe(0);
	const result = await splitVaultKeys(source, prefixGroupsFor(keys("app")), true, api);
	expect(creates).toBe(1);
	expect(copies).toBe(0);
	expect(result.groups[0]?.status).toBe("unconfirmed");
	expect(result.groups[0]?.target).toBeUndefined();
});

test("retirement during creation prevents copy/delete and later destination creation", async () => {
	let current = true;
	let creates = 0;
	const result = await splitVaultKeys(
		source,
		prefixGroupsFor([...keys("app"), ...keys("other")]),
		true,
		{
			create: async (body) => {
				creates++;
				current = false;
				return target(body.slug);
			},
			copyItems: async () => {
				throw new Error("Must not copy after retirement");
			},
			deleteItems: async () => {
				throw new Error("Must not delete after retirement");
			},
		},
		() => current,
	);
	expect(creates).toBe(1);
	expect(result.interrupted).toBe(true);
	expect(result.groups[0]?.status).toBe("unconfirmed");
	expect(result.groups[0]?.target?.id).toBe("id-app");
});
