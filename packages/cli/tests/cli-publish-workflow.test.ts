import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowJob {
	if?: string;
	needs?: unknown;
	"runs-on"?: string;
	permissions?: Record<string, string>;
	steps?: Array<Record<string, unknown>>;
}

interface WorkflowDocument {
	jobs: Record<string, WorkflowJob>;
}

const workflow = readFileSync(
	resolve(import.meta.dir, "../../../.github/workflows/cli-publish.yml"),
	"utf8",
);
const workflowDocument = parse(workflow) as WorkflowDocument;
const publishManifestCheckerPath = resolve(
	import.meta.dir,
	"../scripts/check-publish-manifest.mjs",
);
const publishManifestChecker = readFileSync(publishManifestCheckerPath, "utf8");
const cliPackage = JSON.parse(
	readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
) as {
	name: string;
	version: string;
	publishConfig?: { access?: string; tag?: unknown };
};

describe("CLI pack inventory", () => {
	const packed = {
		id: `${cliPackage.name}@${cliPackage.version}`,
		name: cliPackage.name,
		version: cliPackage.version,
		filename: `${cliPackage.name}-${cliPackage.version}.tgz`,
		files: [
			{ path: "package.json" },
			{ path: "egress-addon/clawdi_egress_addon.py" },
			{ path: "skills/future-skill/SKILL.md" },
		],
	};
	const check = (inventory: unknown) =>
		spawnSync("node", [publishManifestCheckerPath, "--pack-json"], {
			input: JSON.stringify(inventory),
			encoding: "utf8",
		});

	test("accepts the exact source and additional intentional skill files", () => {
		for (const inventory of [[packed], { [cliPackage.name]: packed }]) {
			const result = check(inventory);
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe(packed.filename);
		}
	});

	test("rejects Python cache directories and bytecode anywhere in the package", () => {
		for (const path of [
			"egress-addon/__pycache__/cache.json",
			"egress-addon/addon.pyc",
			"skills/future-skill/cache.pyo",
		]) {
			const result = check([{ ...packed, files: [...packed.files, { path }] }]);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(path);
			expect(result.stdout).toBe("");
		}
	});

	test("fails closed for invalid inventory, identity or missing addon source", () => {
		for (const inventory of [
			null,
			[],
			[packed, packed],
			{ [cliPackage.name]: packed, other: packed },
			{ other: packed },
			{ [cliPackage.name]: [packed] },
			...[[packed], { [cliPackage.name]: packed }].flatMap((shape) =>
				[
					{ ...packed, id: "other@1.0.0" },
					{ ...packed, name: "other" },
					{ ...packed, version: "unreviewed" },
					{ ...packed, filename: `../${packed.filename}` },
					...["../escape", "/absolute", "a/../b", "a//b", "./file", "a\\b", "C:drive", "a\n"].map(
						(path) => ({ ...packed, files: [...packed.files, { path }] }),
					),
				].map((entry) => (Array.isArray(shape) ? [entry] : { [cliPackage.name]: entry })),
			),
			[{ ...packed, files: [{ path: 1 }] }],
			[{ ...packed, files: [{ path: "package.json" }] }],
		]) {
			const result = check(inventory);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
		}
	});
});

describe("CLI publish workflow contract", () => {
	test("publishes only v2 and verifies all eight native archives", () => {
		const build = workflowDocument.jobs["build-immutable-artifact"];
		const publish = workflowDocument.jobs["publish-immutable-artifact-with-oidc"];
		expect(build.steps?.find((step) => step.id === "pack_release")?.run).toContain(
			'cp dist-release/clawdi-cli-manifest-v2.txt "$release_dir/"',
		);
		const verification = publish.steps?.find((step) => step.id === "verify_release")?.run;
		expect(workflow).not.toContain("clawdi-cli-manifest.txt");
		expect(verification).toContain("test -s clawdi-cli-manifest-v2.txt");
		expect(verification).toContain(
			"for target in linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl darwin-x64 darwin-arm64 win32-x64 win32-arm64; do",
		);
		const release = publish.steps?.find((step) => step.id === "release")?.run;
		expect(typeof release).toBe("string");
		if (typeof release !== "string") throw new Error("release step is missing");
		expect(release.match(/release\/clawdi-cli-manifest-v2\.txt/g)).toHaveLength(2);
	});

	test("ships both platform installers as verified release assets", () => {
		const build = workflowDocument.jobs["build-immutable-artifact"];
		const publish = workflowDocument.jobs["publish-immutable-artifact-with-oidc"];
		expect(build.steps?.find((step) => step.id === "pack_release")?.run).toContain(
			'cp ../../install.ps1 "$release_dir/"',
		);
		expect(build.steps?.find((step) => step.id === "pack_release")?.run).toContain(
			"[ScriptBlock]::Create((Get-Content -Raw ../../install.ps1))",
		);
		expect(publish.steps?.find((step) => step.id === "verify_release")?.run).toContain(
			"test -s install.ps1",
		);
		const release = publish.steps?.find((step) => step.id === "release")?.run;
		if (typeof release !== "string") throw new Error("release step is missing");
		expect(release.match(/release\/install\.ps1/g)).toHaveLength(2);
	});

	test("attests native archives and the v2 manifest after verification and before release", () => {
		const publish = workflowDocument.jobs["publish-immutable-artifact-with-oidc"];
		const steps = publish.steps ?? [];
		const attestIndex = steps.findIndex((step) => step.uses === "actions/attest@v4");
		expect(attestIndex).toBeGreaterThan(steps.findIndex((step) => step.id === "verify_release"));
		expect(attestIndex).toBeLessThan(steps.findIndex((step) => step.id === "release"));
		expect(steps[attestIndex]?.with).toEqual({
			"subject-path": "release/clawdi-cli-*.tar.gz\nrelease/clawdi-cli-manifest-v2.txt\n",
		});
		for (const permission of ["id-token", "attestations", "artifact-metadata"]) {
			expect(publish.permissions?.[permission]).toBe("write");
		}
	});

	test("keeps current-run release decisions inside the protected publish topology", () => {
		const build = workflowDocument.jobs["build-immutable-artifact"];
		const sign = workflowDocument.jobs["sign-macos-native"];
		const publish = workflowDocument.jobs["publish-immutable-artifact-with-oidc"];

		expect(Object.keys(workflowDocument.jobs)).toEqual([
			"release-check",
			"build-immutable-artifact",
			"sign-macos-native",
			"publish-immutable-artifact-with-oidc",
		]);
		expect(build.permissions).toEqual({ contents: "read" });
		expect(build.needs).toBe("release-check");
		expect(build.if).toBe("needs.release-check.outputs.publish == 'true'");
		expect(sign.needs).toBe("build-immutable-artifact");
		expect(publish.needs).toEqual(["build-immutable-artifact", "sign-macos-native"]);
		expect(publish.permissions).toEqual({
			contents: "write",
			"id-token": "write",
			attestations: "write",
			"artifact-metadata": "write",
		});
		expect(build.steps?.find((step) => step.id === "check")?.["working-directory"]).toBe(
			"packages/cli",
		);
		expect(build.steps?.map((step) => step.id).filter(Boolean)).toEqual([
			"check",
			"build_native_release",
			"pack_release",
		]);
		for (const stepId of ["build_native_release", "pack_release"]) {
			expect(build.steps?.find((step) => step.id === stepId)?.["working-directory"]).toBe(
				"packages/cli",
			);
		}
		expect(publish.steps?.map((step) => step.id).filter(Boolean)).toEqual([
			"verify_release",
			"release",
			"publish",
		]);
	});

	test("keeps the protected OIDC publish fully repository-local", () => {
		const build = workflow.indexOf("  build-immutable-artifact:");
		const publish = workflow.indexOf("  publish-immutable-artifact-with-oidc:");
		const buildJob = workflow.slice(build, publish);
		const publishJob = workflow.slice(publish);

		expect(build).toBeGreaterThan(-1);
		expect(publish).toBeGreaterThan(build);
		expect(buildJob).toContain(
			`runs-on: \${{ vars.CI_RUNNER || 'blacksmith-16vcpu-ubuntu-2404' }}`,
		);
		expect(publishJob).toContain("runs-on: ubuntu-latest");
		expect(publishJob).not.toContain("vars.CI_RUNNER");
		expect(workflow).toContain("needs: [build-immutable-artifact, sign-macos-native]");
		expect(workflow).toContain("environment: npm");
		expect(workflow).toContain("id-token: write");
		expect(publishJob).toContain('node-version: "24"');
		expect(publishJob).toContain("npm install --global npm@12.0.2");
		expect(publishJob).toContain('test "$(npm --version)" = "12.0.2"');
		expect(workflow.match(/test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/g)).toHaveLength(2);
		expect(workflow).not.toContain("git checkout --detach");
		expect(workflow).not.toContain("source_commit");
		expect(workflow).not.toContain("Clawdi-AI/clawdi-hosted");
		expect(workflow).not.toContain("uses: Clawdi-AI/");
		expect(workflow).not.toContain("repository_dispatch");
		expect(workflow).not.toContain("workflow_run");
		expect(workflow).not.toContain("repository: Clawdi-AI/");
	});

	test("signs macOS archives before refreshing hashes and publishing", () => {
		const sign = workflowDocument.jobs["sign-macos-native"];
		const signRun = sign.steps?.find((step) =>
			String(step.name).startsWith("Sign and notarize"),
		)?.run;
		expect(sign?.["runs-on"]).toBe("macos-14");
		expect(typeof signRun).toBe("string");
		if (typeof signRun !== "string") throw new Error("signing step is missing");
		for (const secret of [
			"CSC_LINK",
			"CSC_KEY_PASSWORD",
			"APPLE_API_KEY_CONTENT",
			"APPLE_API_KEY_ID",
			"APPLE_API_ISSUER",
		]) {
			expect(signRun).toContain(secret);
		}
		expect(signRun).toContain("with-signing-keychain.sh");
		expect(signRun).toContain(
			"bash ./apps/desktop/scripts/with-signing-keychain.sh bash -s <<'SIGN'",
		);
		expect(signRun).toContain("codesign --force --options runtime --timestamp");
		expect(signRun).toContain("--identifier ai.clawdi.cli");
		expect(signRun).toContain("--entitlements");
		expect(signRun).toContain("xcrun notarytool submit");
		expect(signRun).toContain("xcrun notarytool log");
		expect(signRun).toContain("submission_status");
		expect(signRun).toContain("status=$" + "{submission_status:-unknown}");
		expect(signRun).toContain("Apple notarization did not succeed");
		expect(signRun).toContain("notarizing_macos_software_before_distribution");
		expect(signRun).toContain("TN2206");
		expect(signRun).toContain("spctl --assess --type execute");
		expect(signRun).toContain("if ! spctl --assess --type execute");
		expect(signRun).toContain("informational assessment rejected the bare CLI");
		expect(signRun.indexOf("xcrun notarytool log")).toBeLessThan(
			signRun.indexOf("if ! spctl --assess --type execute"),
		);
		expect(signRun).toContain("Bare executables cannot be stapled");
		expect(signRun).toContain("for target in darwin-x64 darwin-arm64; do");
		expect(signRun).toContain('tar -xpzf "$archive" -C "$stage"');
		expect(signRun).toContain(
			'CLAWDI_NATIVE_TARGET="$target" bun run packages/cli/scripts/package-native-release.mjs',
		);
		expect(signRun).toContain('"$stage" "$PWD/release"');
		expect(signRun.indexOf("if ! spctl --assess --type execute")).toBeLessThan(
			signRun.indexOf("package-native-release.mjs"),
		);
		expect(signRun).toContain("refresh-native-release-manifest.mjs");
		expect(signRun.indexOf("package-native-release.mjs")).toBeLessThan(
			signRun.indexOf("refresh-native-release-manifest.mjs"),
		);
		expect(signRun.indexOf("refresh-native-release-manifest.mjs")).toBeLessThan(
			signRun.indexOf("check-native-release.mjs"),
		);
		const buildScript = readFileSync(
			resolve(import.meta.dir, "../scripts/build-native-release.mjs"),
			"utf8",
		);
		expect(buildScript).toContain('run(resolve(scriptDir, "package-native-release.mjs")');
		expect(signRun).not.toContain("exit 0");
	});

	test("fails before signing or final upload when any release credential is missing", () => {
		const sign = workflowDocument.jobs["sign-macos-native"];
		const signStep = sign.steps?.find((step) => String(step.name).startsWith("Sign and notarize"));
		const run = signStep?.run;
		if (typeof run !== "string") throw new Error("signing step is missing");
		expect(signStep?.if).toBeUndefined();
		expect(signStep?.["continue-on-error"]).toBeUndefined();
		const credentials = {
			CSC_LINK: "fixture",
			CSC_KEY_PASSWORD: "fixture",
			APPLE_API_KEY_CONTENT: "fixture",
			APPLE_API_KEY_ID: "fixture",
			APPLE_API_ISSUER: "fixture",
		};
		for (const missing of Object.keys(credentials)) {
			const result = spawnSync("bash", ["--noprofile", "--norc", "-c", run], {
				encoding: "utf8",
				env: { PATH: process.env.PATH, ...credentials, [missing]: "" },
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("credentials are incomplete");
			expect(result.stdout).toBe("");
		}
		const steps = sign.steps ?? [];
		expect(steps.findIndex((step) => step.uses === "actions/upload-artifact@v7")).toBeGreaterThan(
			steps.indexOf(signStep ?? {}),
		);
		const publish = workflowDocument.jobs["publish-immutable-artifact-with-oidc"];
		expect(publish.needs).toContain("sign-macos-native");
		expect(publish.if).toBeUndefined();
	});

	test("complete credentials sign both Darwin archives and refresh the actual manifest", () => {
		const run = workflowDocument.jobs["sign-macos-native"].steps?.find((step) =>
			String(step.name).startsWith("Sign and notarize"),
		)?.run;
		if (typeof run !== "string") throw new Error("signing step is missing");
		const directory = mkdtempSync(join(tmpdir(), "clawdi-signing-workflow-"));
		try {
			const bin = join(directory, "bin");
			const release = join(directory, "release");
			const runnerTemp = join(directory, "runner-temp");
			for (const path of [bin, release, runnerTemp, join(directory, "apps/desktop/scripts")])
				mkdirSync(path, { recursive: true });
			symlinkSync(
				resolve(import.meta.dir, "../../../packages"),
				join(directory, "packages"),
				"dir",
			);
			writeFileSync(
				join(directory, "apps/desktop/scripts/with-signing-keychain.sh"),
				'#!/bin/sh\nexec "$@"\n',
			);
			// Apple tooling is unavailable on Linux. Exercise the real shell gates,
			// archive repacking and manifest checks with only the OS tools replaced.
			const tools: Record<string, string> = {
				codesign: `case "$1" in
  --force) for cli do :; done; printf '\n# signed fixture\n' >> "$cli" ;;
  -dv) printf 'Authority=Developer ID Application: Fixture\nTeamIdentifier=ABCDE12345\n' >&2 ;;
esac`,
				xcrun: `case "$2" in
  submit) printf '{"id":"fixture-submission","status":"Accepted"}\n' ;;
  *) printf '{}\n' ;;
esac`,
				ditto: "exit 0",
				spctl: "exit 1",
			};
			for (const [name, script] of Object.entries(tools))
				writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${script}\n`, { mode: 0o755 });
			const targets = [
				"linux-x64",
				"linux-arm64",
				"linux-x64-musl",
				"linux-arm64-musl",
				"darwin-x64",
				"darwin-arm64",
				"win32-x64",
				"win32-arm64",
			];
			const before = new Map<string, string>();
			for (const target of targets) {
				const stage = join(directory, target);
				for (const file of [
					target.startsWith("win32") ? "clawdi.exe" : "clawdi",
					"egress-addon/clawdi_egress_addon.py",
					"skills/clawdi/SKILL.md",
					"skills/hosted-versions/1/clawdi/SKILL.md",
				]) {
					mkdirSync(resolve(stage, file, ".."), { recursive: true });
					writeFileSync(join(stage, file), "fixture payload", { mode: 0o755 });
				}
				const pack = spawnSync(
					process.execPath,
					[resolve(import.meta.dir, "../scripts/package-native-release.mjs"), stage, release],
					{ encoding: "utf8", env: { ...process.env, CLAWDI_NATIVE_TARGET: target } },
				);
				expect(pack.status).toBe(0);
				before.set(
					target,
					createHash("sha256")
						.update(readFileSync(join(release, `clawdi-cli-${target}.tar.gz`)))
						.digest("hex"),
				);
			}
			const result = spawnSync("bash", ["--noprofile", "--norc", "-c", run], {
				cwd: directory,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					RUNNER_TEMP: runnerTemp,
					CLI_VERSION: cliPackage.version,
					CSC_LINK: "fixture",
					CSC_KEY_PASSWORD: "fixture",
					APPLE_API_KEY_CONTENT: "fixture",
					APPLE_API_KEY_ID: "fixture",
					APPLE_API_ISSUER: "fixture",
				},
			});
			expect(result.stderr).not.toContain("Error");
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("v2: 8 targets");
			const manifest = readFileSync(join(release, "clawdi-cli-manifest-v2.txt"), "utf8");
			for (const target of targets) {
				const digest = createHash("sha256")
					.update(readFileSync(join(release, `clawdi-cli-${target}.tar.gz`)))
					.digest("hex");
				expect(digest === before.get(target)).toBe(!target.startsWith("darwin"));
				expect(manifest).toContain(`artifact\t${target}\tclawdi-cli-${target}.tar.gz\t${digest}`);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("keeps every macOS shell step free of GNU-only commands", () => {
		const sign = workflowDocument.jobs["sign-macos-native"];
		for (const step of sign.steps ?? []) {
			if (typeof step.run !== "string") continue;
			expect(step.run).not.toMatch(/--(?:owner|group|numeric-owner|sort|mtime)(?:[=\s]|$)/);
			expect(step.run).not.toMatch(/\b(?:sha256sum|mapfile|readarray)\b|\bsed\s+-i\b/);
			expect(step.run).not.toMatch(/\btar\s[^\n]*\s-\w*c\w*/);
		}
	});

	test("builds and publishes the same verified tarball exactly once", () => {
		const build = workflowDocument.jobs["build-immutable-artifact"];
		const publish = workflowDocument.jobs["publish-immutable-artifact-with-oidc"];
		const uploadArtifact = build.steps?.find((step) => step.uses === "actions/upload-artifact@v7");
		const downloadArtifact = publish.steps?.find(
			(step) => step.uses === "actions/download-artifact@v8",
		);
		const publishCommands = workflow.match(/npm publish /g) ?? [];

		expect(uploadArtifact?.with).toEqual({
			name: `\${{ env.CLI_ARTIFACT_NAME }}`,
			path: `\${{ runner.temp }}/clawdi-cli-release/`,
			"if-no-files-found": "error",
			"retention-days": 1,
		});
		expect(downloadArtifact?.with).toEqual({
			name: `\${{ env.CLI_FINAL_ARTIFACT_NAME }}`,
			path: "release",
		});
		expect(publishCommands).toHaveLength(1);
		expect(workflow).not.toContain("publishConfig");
		expect(workflow).toContain(
			`NPM_TAG: \${{ needs['build-immutable-artifact'].outputs.npm_tag }}`,
		);
		expect(workflow).toContain(
			'npm publish "./release/$CLI_TARBALL_FILENAME" --access public --provenance --ignore-scripts --tag "$NPM_TAG"',
		);
		expect(workflow).toContain("*-*) npm_tag=beta ;;");
		expect(workflow).toContain("*) npm_tag=latest ;;");
		expect(cliPackage.publishConfig).toEqual({ access: "public" });
		expect(publishManifestChecker).toContain(
			'Object.hasOwn(packageJson.publishConfig ?? {}, "tag")',
		);
		expect(publishManifestChecker).toContain(
			"published CLI package must not declare publishConfig.tag",
		);
		expect(workflow).toContain("node scripts/check-publish-manifest.mjs");
		expect(build.steps?.find((step) => step.id === "pack_release")?.run).toContain(
			'tarball=$(node scripts/check-publish-manifest.mjs --pack-json <<< "$pack_json")',
		);
		expect(workflow).toContain("CLI_ARTIFACT_NAME: clawdi-cli-release");
		expect(workflow).toContain(
			`CLI_TARBALL_FILENAME: \${{ needs['build-immutable-artifact'].outputs.cli_tarball_filename }}`,
		);
		expect(workflow).toContain('tarball="$CLI_TARBALL_FILENAME"');
		expect(workflow).toContain(`name: \${{ env.CLI_ARTIFACT_NAME }}`);
		expect(workflow).toContain("run: bun run typecheck");
		const testStep = build.steps?.find((step) => step.name === "Test (ephemeral internal suite)");
		expect(testStep).toMatchObject({
			"timeout-minutes": 20,
			run: "bun run --cwd packages/cli test:internal",
		});
		expect(workflow).toContain("- name: Native lifecycle (ephemeral internal suite)");
		expect(workflow.indexOf("- name: Test")).toBeLessThan(
			workflow.indexOf("- name: Build package and native release matrix"),
		);
		expect(workflow).toContain('npm install "$tarball_path" --ignore-scripts --no-audit --no-fund');
		expect(workflow).toContain('sha256sum --check "$tarball.sha256"');
		expect(workflow.match(/npm pack /g) ?? []).toHaveLength(1);
		expect(workflow.indexOf("npm pack ")).toBeLessThan(workflow.indexOf("npm publish "));
		expect(workflow).not.toMatch(/npm dist-tag (?:add|rm)/);
		expect(workflow).not.toContain("npm stage publish");
		expect(workflow).not.toContain("NPM_TOKEN");
	});

	test("publishes only an absent exact version and verifies artifact integrity", () => {
		const publishJob = workflow.slice(workflow.indexOf("  publish-immutable-artifact-with-oidc:"));
		const absenceCheck = publishJob.indexOf("if ! npm_release_visible; then");
		const publishCommand = publishJob.indexOf("npm publish ");
		const visibilityWait = publishJob.indexOf("for attempt in $(seq 1 60); do", publishCommand);
		const versionRead = publishJob.indexOf(
			'registry_version=$(npm view "clawdi@$VERSION" version)',
		);
		const integrityRead = publishJob.indexOf(
			'published_integrity=$(npm view "clawdi@$VERSION" dist.integrity)',
		);

		expect(workflow).toContain('- "packages/cli/package.json"');
		expect(absenceCheck).toBeGreaterThan(-1);
		expect(absenceCheck).toBeLessThan(publishCommand);
		expect(visibilityWait).toBeGreaterThan(publishCommand);
		expect(visibilityWait).toBeLessThan(versionRead);
		expect(versionRead).toBeLessThan(integrityRead);
		expect(publishJob).toContain('test "$registry_version" = "$VERSION"');
		expect(publishJob).toContain('if [ "$published_integrity" != "$local_integrity" ]; then');
		expect(publishJob).toContain(
			'echo "clawdi@$VERSION registry integrity does not match this workflow artifact" >&2',
		);
		expect(workflow).toContain('if [ "$attempt" -lt 60 ]; then sleep 10; fi');
		expect(workflow).toContain(
			'echo "clawdi@$VERSION was not visible in the npm registry after 10 minutes" >&2',
		);
	});

	test("creates or completes only the current commit GitHub release", () => {
		expect(workflow.indexOf('release create "$tag"')).toBeLessThan(
			workflow.indexOf("npm publish "),
		);
		expect(workflow.lastIndexOf('gh release edit "$tag" --draft=false')).toBeLessThan(
			workflow.indexOf("npm publish "),
		);
		expect(workflow).toContain('if [ "$tag_commit" != "$GITHUB_SHA" ]; then');
		expect(workflow).toContain("release.targetCommitish !== process.env.EXPECTED_COMMIT");
		expect(workflow).toContain('console.log(release.isDraft ? "resume-draft" : "none")');
		expect(workflow).toContain('gh release upload "$tag"');
		expect(workflow).toContain('--target "$GITHUB_SHA"');
		expect(workflow).toContain("--draft");
		expect(workflow).toContain('gh release edit "$tag" --draft=false');
		expect(workflow.match(/gh release upload /g)).toHaveLength(1);
		expect(workflow.match(/gh release edit "\$tag" --draft=false/g)).toHaveLength(2);
		expect(workflow.match(/release create "\$tag"/g)).toHaveLength(1);
		expect(workflow).toContain('case "$NPM_TAG" in');
		expect(workflow).toContain("args+=(--prerelease)");
		expect(workflow).toContain("latest) ;;");
		expect(workflow).toContain('echo "unsupported npm release tag: $NPM_TAG" >&2');
		expect(workflow).not.toContain("pull_request:");
	});
});
describe("CLI publish eligibility", () => {
	function checkRelease(options: {
		previousVersion?: string;
		publishedVersions?: string[];
		eventName?: string;
		npmFailure?: boolean;
		gitFailure?: boolean;
		invalidRegistryResponse?: boolean;
	}) {
		const run = workflowDocument.jobs["release-check"].steps?.find(
			(step) => step.id === "check",
		)?.run;
		if (typeof run !== "string") throw new Error("release eligibility step is missing");
		const directory = mkdtempSync(join(tmpdir(), "clawdi-release-check-"));
		try {
			const bin = join(directory, "bin");
			mkdirSync(bin);
			writeFileSync(join(directory, "package.json"), JSON.stringify(cliPackage));
			writeFileSync(join(directory, "outputs"), "");
			writeFileSync(
				join(bin, "git"),
				'#!/bin/sh\n[ "$GIT_FAILURE" != true ] || exit 1\nprintf \'%s\\n\' "$PREVIOUS_PACKAGE"\n',
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "npm"),
				'#!/bin/sh\necho queried > "$NPM_CALL"\n[ "$NPM_FAILURE" != true ] || exit 1\nprintf \'%s\\n\' "$REGISTRY_VERSIONS"\n',
				{ mode: 0o755 },
			);
			const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
				cwd: directory,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					GITHUB_OUTPUT: join(directory, "outputs"),
					EVENT_NAME: options.eventName ?? "push",
					PREVIOUS_SHA: "previous-push-commit",
					PREVIOUS_PACKAGE: JSON.stringify({ version: options.previousVersion ?? "0.0.0" }),
					REGISTRY_VERSIONS: options.invalidRegistryResponse
						? "null"
						: JSON.stringify(options.publishedVersions ?? []),
					NPM_CALL: join(directory, "npm-call"),
					NPM_FAILURE: String(options.npmFailure ?? false),
					GIT_FAILURE: String(options.gitFailure ?? false),
				},
			});
			return {
				...result,
				outputs: readFileSync(join(directory, "outputs"), "utf8"),
			};
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	test("skips non-version edits without querying npm", () => {
		const result = checkRelease({ previousVersion: cliPackage.version, npmFailure: true });
		expect(result.status).toBe(0);
		expect(result.outputs).toBe("publish=false\n");
		expect(result.stdout).toContain("did not change");
	});

	test("skips a version that npm already contains", () => {
		const result = checkRelease({ publishedVersions: [cliPackage.version] });
		expect(result.status).toBe(0);
		expect(result.outputs).toBe("publish=false\n");
		expect(result.stdout).toContain("is already on npm");
	});

	test("allows an unpublished bumped version", () => {
		const result = checkRelease({});
		expect(result.status).toBe(0);
		expect(result.outputs).toBe("publish=true\n");
	});

	test("allows a manual retry of an unpublished version without a push baseline", () => {
		const result = checkRelease({ eventName: "workflow_dispatch", gitFailure: true });
		expect(result.status).toBe(0);
		expect(result.outputs).toBe("publish=true\n");
	});

	test("fails closed on registry, baseline, or invalid response errors", () => {
		for (const options of [
			{ npmFailure: true },
			{ gitFailure: true },
			{ invalidRegistryResponse: true },
		]) {
			const result = checkRelease(options);
			expect(result.status).not.toBe(0);
			expect(result.outputs).toBe("");
		}
	});
});
