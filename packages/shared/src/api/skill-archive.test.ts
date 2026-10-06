import { expect, test } from "bun:test";
import type { components } from "./api.generated";
import { createSkillClient, MAX_SKILL_ARCHIVE_BYTES } from "./skill-client";
import { transferSkill } from "./skill-transfer";

const receipt = {
	skill_key: "tools/demo",
	content_hash: "a".repeat(64),
	name: "Demo",
	version: 1,
	file_count: 1,
};
const project: components["schemas"]["ProjectResponse"] = {
	id: "source",
	name: "Source",
	slug: "source",
	kind: "workspace",
	description: null,
	origin_environment_id: null,
	archived_at: null,
	created_at: "2026-10-03T00:00:00Z",
	is_owner: true,
	skill_count: 1,
	vault_count: 0,
	agent_count: 0,
	member_count: 0,
};
const skill = {
	project_id: project.id,
	authority: "cloud",
	project_kind: "workspace",
	skill_key: receipt.skill_key,
	content_hash: receipt.content_hash,
} satisfies Pick<
	components["schemas"]["SkillSummaryResponse"],
	"project_id" | "authority" | "project_kind" | "skill_key" | "content_hash"
>;

test("Skill archives preserve multipart bytes/create-only and binary download without JSON conversion", async () => {
	const observed: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			if (request.method === "GET") {
				expect(new URL(request.url).pathname).toBe(
					"/v1/projects/project%2Fa/skills/tools%2Fdemo/download",
				);
				return new Response(new Uint8Array([31, 139, 0, 255]), {
					headers: { "content-type": "application/gzip" },
				});
			}
			const form = await request.formData();
			const file = form.get("file");
			if (!(file instanceof File)) throw new Error("Expected archive");
			observed.push({
				path: new URL(request.url).pathname,
				key: form.get("skill_key"),
				create: form.get("create_only"),
				bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
			});
			return Response.json(receipt);
		},
	});
	try {
		const client = createSkillClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		const archive = await client.download("project/a", "tools/demo");
		await client.upload("target", "tools/demo", archive, true);
		expect(observed).toEqual([
			{
				path: "/v1/projects/target/skills/upload",
				key: "tools/demo",
				create: "true",
				bytes: [31, 139, 0, 255],
			},
		]);
	} finally {
		server.stop(true);
	}
});

test("invalid archive sizes fail before auth and ambiguous uploads are never retried", async () => {
	let tokens = 0;
	let sends = 0;
	const client = createSkillClient({
		baseUrl: "https://api.example",
		getToken: async () => {
			tokens++;
			return "fixture";
		},
		fetch: async () => {
			sends++;
			return Response.json({}, { status: 503 });
		},
	});
	for (const archive of [new Blob([]), new Blob([new Uint8Array(MAX_SKILL_ARCHIVE_BYTES + 1)])])
		await expect(client.upload("target", "demo", archive, true)).rejects.toMatchObject({
			status: 400,
		});
	expect(tokens).toBe(0);
	await expect(client.upload("target", "demo", new Blob(["archive"]), true)).rejects.toMatchObject({
		status: 503,
	});
	expect(sends).toBe(1);
});

test("moves confirm destination before revision deletion and preserve partial copies", async () => {
	const order: string[] = [];
	let uploadFails = true;
	let deleteFails = false;
	const input = {
		skill,
		source: project,
		target: { ...project, id: "target" },
		move: true,
		download: async () => {
			order.push("download");
			return new Blob(["archive"]);
		},
		upload: async () => {
			order.push("upload");
			if (uploadFails) throw new Error("Uncertain upload");
			return receipt;
		},
		remove: async (hash: string) => {
			expect(hash).toBe(receipt.content_hash);
			order.push("delete");
			if (deleteFails) throw new Error("Revision conflict");
		},
	};
	await expect(transferSkill(input)).rejects.toThrow("Uncertain upload");
	expect(order).toEqual(["download", "upload"]);
	order.length = 0;
	uploadFails = false;
	deleteFails = true;
	expect(await transferSkill(input)).toEqual({ sourceRemoved: false });
	expect(order).toEqual(["download", "upload", "delete"]);
	order.length = 0;
	deleteFails = false;
	expect(await transferSkill(input)).toEqual({ sourceRemoved: true });
	expect(order).toEqual(["download", "upload", "delete"]);
	order.length = 0;
	expect(await transferSkill({ ...input, move: false })).toEqual({ sourceRemoved: null });
	expect(order).toEqual(["download", "upload"]);
	order.length = 0;
	await expect(
		transferSkill({ ...input, upload: async () => ({ ...receipt, skill_key: "foreign" }) }),
	).rejects.toThrow("API response could not be read");
	expect(order).toEqual(["download"]);
	order.length = 0;
	expect(
		await transferSkill({
			...input,
			upload: async () => ({ ...receipt, content_hash: "b".repeat(64) }),
		}),
	).toEqual({ sourceRemoved: false });
	expect(order).toEqual(["download"]);
});

test("transfer rejects cross-scope, archived, shared, Agent-synced and same-Project targets before I/O", async () => {
	let calls = 0;
	const input = {
		skill,
		source: project,
		target: { ...project, id: "target" },
		move: true,
		download: async () => {
			calls++;
			return new Blob(["archive"]);
		},
		upload: async () => receipt,
		remove: async () => {},
	};
	for (const bad of [
		{ ...input, source: { ...project, id: "other" } },
		{ ...input, source: { ...project, is_owner: false } },
		{ ...input, skill: { ...skill, authority: "agent_sync" as const } },
		{ ...input, target: project },
		{ ...input, target: { ...project, id: "target", kind: "environment" } },
		{ ...input, target: { ...project, id: "target", archived_at: "2026-10-03" } },
	])
		await expect(transferSkill(bad)).rejects.toMatchObject({ status: 403 });
	expect(calls).toBe(0);
});
