import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(missingAsset = false) {
	const root = mkdtempSync(join(tmpdir(), "desktop-update-site-"));
	roots.push(root);
	mkdirSync(join(root, "bin"));
	const release = (version: string, prerelease: boolean) => ({
		tag_name: `desktop-v${version}`,
		prerelease,
		draft: false,
		assets: [
			{ name: prerelease ? "beta-mac.yml" : "latest-mac.yml", id: 1 },
			{ name: prerelease ? "beta-mac-x64.yml" : "latest-mac-x64.yml", id: prerelease ? 1 : 2 },
			...(missingAsset ? [] : [{ name: "Clawdi.zip" }]),
		],
	});
	// Different metadata per request is supplied by the fake gh using the selected asset ID.
	const stable = release("1.0.0", false);
	stable.assets[0] = { name: "latest-mac.yml", id: 2 };
	writeFileSync(
		join(root, "releases.json"),
		JSON.stringify([
			[{ tag_name: "clawdi-cli-v99.0.0", draft: false }, release("1.1.0-beta.2", true)],
			[release("1.1.0-beta.10", true), stable],
		]),
	);
	writeFileSync(
		join(root, "metadata.json"),
		JSON.stringify({
			version: "1.1.0-beta.10",
			path: "Clawdi.zip",
			files: [{ url: "Clawdi.zip", sha512: "hash", size: 1 }],
		}),
	);
	writeFileSync(
		join(root, "stable.json"),
		JSON.stringify({
			version: "1.0.0",
			path: "Clawdi.zip",
			files: [{ url: "Clawdi.zip", sha512: "hash", size: 1 }],
		}),
	);
	writeFileSync(
		join(root, "bin", "gh"),
		'#!/bin/sh\ncase "$2" in\n  */assets/2) cat "$FIXTURE_ROOT/stable.json" ;;\n  *releases/assets/*) cat "$FIXTURE_ROOT/metadata.json" ;;\n  *) cat "$FIXTURE_ROOT/releases.json" ;;\nesac\n',
		{ mode: 0o700 },
	);
	return root;
}

async function prepare(root: string) {
	const child = Bun.spawn(
		[
			process.execPath,
			resolve(import.meta.dir, "../scripts/prepare-update-site.ts"),
			join(root, "site"),
		],
		{
			env: {
				...process.env,
				PATH: `${join(root, "bin")}:${process.env.PATH}`,
				FIXTURE_ROOT: root,
				GITHUB_REPOSITORY: "owner/repo",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return { code: await child.exited, error: await new Response(child.stderr).text() };
}

test("Pages keeps both channels, paginates releases and selects semantic versions", async () => {
	const root = fixture();
	expect((await prepare(root)).code).toBe(0);
	for (const [file, version] of [
		["latest-mac.yml", "1.0.0"],
		["beta-mac.yml", "1.1.0-beta.10"],
	] as const) {
		const metadata = parse(readFileSync(join(root, "site/desktop", file), "utf8"));
		expect(metadata.version).toBe(version);
		expect(metadata.files[0].url).toBe(
			`https://github.com/owner/repo/releases/download/desktop-v${version}/Clawdi.zip`,
		);
		expect(metadata.path).toBe(metadata.files[0].url);
		const intel = parse(readFileSync(join(root, "site/desktop/darwin-x64", file), "utf8"));
		expect(intel.version).toBe(version);
	}
});

test("Pages refuses metadata pointing to an absent release artifact", async () => {
	const result = await prepare(fixture(true));
	expect(result.code).not.toBe(0);
	expect(result.error).toContain("Missing artifact");
});
