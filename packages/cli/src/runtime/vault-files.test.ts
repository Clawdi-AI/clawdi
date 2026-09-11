import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimePaths } from "./paths";
import { type RuntimeVaultFilesConfig, syncRuntimeVaultFiles } from "./vault-files";

const roots: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "runtime-vault-"));
	roots.push(root);
	const home = join(root, "home");
	mkdirSync(home);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "platform");
	mkdirSync(process.env.CLAWDI_SERVICE_STATE_DIR, { mode: 0o700 });
	const paths = getRuntimePaths({ mode: "hosted" });
	const agentId = randomUUID(),
		vaultId = randomUUID();
	const data = {
		schema_version: 1,
		complete: true,
		agent_id: agentId,
		user_id: randomUUID(),
		vaults: [
			{
				id: vaultId,
				name: "Vault",
				slug: "vault",
				revision: "1",
				project_ids: [randomUUID()],
				fields: [
					{
						id: randomUUID(),
						section: "a",
						name: "TOKEN",
						references: ["clawdi://project/test/vault/vault/TOKEN"],
						value: "first",
					},
					{
						id: randomUUID(),
						section: "b",
						name: "TOKEN",
						references: ["clawdi://project/test/vault/vault/TOKEN"],
						value: "other",
					},
				],
			},
		],
	};
	const config = {
		apiUrl: "",
		apiKey: "fixture-only",
		agentId,
		home,
		workspace: home,
		paths,
		receiptPath: join(paths.serviceStateRoot, "vault-files.json"),
	} satisfies RuntimeVaultFilesConfig;
	return { root, home, config, data };
}

test("HTTP snapshots: stable sections, 304 no IO rewrite, rotation, additions/removal, offline and revocation", async () => {
	const { config, home, data } = fixture();
	let revision = "1",
		status = 200,
		materialStatus = 200,
		requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			requests++;
			expect(request.headers.get("authorization")).toBe("Bearer fixture-only");
			if (new URL(request.url).pathname.endsWith("/material") && materialStatus !== 200)
				return new Response("unavailable", { status: materialStatus });
			if (status !== 200) return new Response("unavailable", { status });
			if (request.headers.get("if-none-match") === revision)
				return new Response(null, { status: 304 });
			return Response.json(data, { headers: { etag: revision } });
		},
	});
	config.apiUrl = server.url.origin;
	try {
		expect(await syncRuntimeVaultFiles(config)).toBe("synced");
		const dir = join(home, ".clawdi", "vaults");
		const parent = join(home, ".clawdi");
		chmodSync(parent, 0o755);
		writeFileSync(join(parent, "config.json"), "unrelated");
		const files = readdirSync(dir).filter(
			(name) => name !== "index.json" && name.endsWith(".json"),
		);
		expect(files).toHaveLength(2);
		expect(lstatSync(dir).mode & 0o777).toBe(0o700);
		for (const file of readdirSync(dir))
			expect(lstatSync(join(dir, file)).mode & 0o777).toBe(0o600);
		const mtimes = files.map((file) => lstatSync(join(dir, file), { bigint: true }).mtimeNs);
		expect(await syncRuntimeVaultFiles(config)).toBe("unchanged");
		expect(files.map((file) => lstatSync(join(dir, file), { bigint: true }).mtimeNs)).toEqual(
			mtimes,
		);
		expect(readFileSync(join(dir, "index.json"), "utf8")).not.toContain('"first"');
		expect(readFileSync(config.receiptPath, "utf8")).not.toContain('"first"');
		const edited = join(dir, files[0]);
		const original = readFileSync(edited, "utf8");
		writeFileSync(edited, "tampered", { mode: 0o600 });
		expect(await syncRuntimeVaultFiles(config)).toBe("synced");
		expect(readFileSync(edited, "utf8")).toBe(original);
		data.vaults[0].fields[0].value = "rotated";
		revision = "2";
		data.vaults[0].revision = revision;
		expect(await syncRuntimeVaultFiles(config)).toBe("synced");
		expect(
			files.map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")).TOKEN).sort(),
		).toEqual(["other", "rotated"]);
		status = 503;
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow("Runtime Vault files");
		expect(readdirSync(dir)).toHaveLength(4);
		status = 200;
		revision = "3";
		data.vaults[0].revision = revision;
		data.vaults[0].fields.splice(0, 1);
		await syncRuntimeVaultFiles(config);
		expect(readdirSync(dir)).toHaveLength(3);
		data.complete = false;
		revision = "4";
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow("Runtime Vault files");
		expect(readdirSync(dir)).toHaveLength(3);
		data.complete = true;
		data.vaults.splice(0);
		revision = "5";
		materialStatus = 503;
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow("Runtime Vault files");
		expect(readdirSync(dir).sort()).toEqual([".gitignore", "index.json"]);
		expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).vaults).toEqual([]);
		status = 403;
		expect(await syncRuntimeVaultFiles(config)).toBe("revoked");
		expect(readdirSync(dir)).toHaveLength(0);
		expect(requests).toBe(14);
		expect(lstatSync(parent).mode & 0o777).toBe(0o755);
		expect(readFileSync(join(parent, "config.json"), "utf8")).toBe("unrelated");
	} finally {
		server.stop(true);
	}
});

test("unowned directories, symlink ancestors, hardlinks and tracked targets fail without altering user files", async () => {
	const { config, home, root, data } = fixture();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json(data, { headers: { etag: "one" } }),
	});
	config.apiUrl = server.url.origin;
	const target = join(home, ".clawdi", "vaults");
	const parent = join(home, ".clawdi");
	mkdirSync(parent, { mode: 0o755 });
	writeFileSync(join(parent, "config.json"), "unrelated");
	try {
		mkdirSync(target);
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow();
		writeFileSync(join(target, "user.txt"), "user");
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow();
		expect(readFileSync(join(target, "user.txt"), "utf8")).toBe("user");
		rmSync(target, { recursive: true });
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, target);
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow();
		expect(readdirSync(outside)).toEqual([]);
		unlinkSync(target);
		execFileSync("git", ["init", home], { stdio: "ignore" });
		execFileSync("git", ["-C", home, "add", ".clawdi/config.json"]);
		mkdirSync(target);
		writeFileSync(join(target, "tracked"), "tracked");
		execFileSync("git", ["-C", home, "add", ".clawdi/vaults/tracked"]);
		rmSync(target, { recursive: true });
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow();
		execFileSync("git", ["-C", home, "rm", "--cached", ".clawdi/vaults/tracked"], {
			stdio: "ignore",
		});
		await syncRuntimeVaultFiles(config);
		expect(lstatSync(parent).mode & 0o777).toBe(0o755);
		expect(readFileSync(join(parent, "config.json"), "utf8")).toBe("unrelated");
		const name = readdirSync(target).find(
			(name) => name !== "index.json" && name.endsWith(".json"),
		);
		if (!name) throw new Error("missing fixture file");
		const file = join(target, name);
		const copy = join(outside, "hardlink");
		linkSync(file, copy);
		const original = readFileSync(copy, "utf8");
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow();
		expect(readFileSync(copy, "utf8")).toBe(original);
	} finally {
		server.stop(true);
	}
});

test("symlink and writable .clawdi parents are refused without touching their contents", async () => {
	const { config, home, root, data } = fixture();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json(data, { headers: { etag: "one" } }),
	});
	config.apiUrl = server.url.origin;
	const outside = join(root, "outside");
	mkdirSync(outside);
	const parent = join(home, ".clawdi");
	symlinkSync(outside, parent);
	try {
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow();
		expect(readdirSync(outside)).toEqual([]);
		unlinkSync(parent);
		mkdirSync(parent);
		chmodSync(parent, 0o777);
		await expect(syncRuntimeVaultFiles(config)).rejects.toThrow();
		expect(lstatSync(parent).mode & 0o777).toBe(0o777);
		expect(readdirSync(parent)).toEqual([]);
	} finally {
		server.stop(true);
	}
});
