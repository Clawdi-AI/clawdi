import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCliVersion } from "../lib/version";
import {
	HERMES_DASHBOARD_BUILD_REVISION_FILE,
	prepareHermesDashboardBuild,
} from "./hermes-dashboard-build";
import { observeRuntimeInstall, runtimeCommandCurrentRevision } from "./manifest-install";
import { getRuntimePaths } from "./paths";
import {
	anonymousInstallerEnvironment,
	preinstallationSpecSchema,
	preinstallationTreeSha256,
	prepareRuntimePreinstallation,
} from "./preinstallation";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const script = `#!/bin/bash
# --runtime-only is required by the contract
set -eu
test "$1" = --prefix
prefix="$2"
test "$3" = --version
test -f "$4"
test "$(stat -c %a "$4")" = 444
version="2026.9.8"
test "$5" = --runtime-only
test "$6" = --no-onboard
test -z "\${CLAWDI_AUTH_TOKEN:-}"
test -z "\${OPENAI_API_KEY:-}"
test -z "\${NODE_OPTIONS:-}"
test "$GIT_CONFIG_GLOBAL" = /dev/null
test "$NPM_CONFIG_USERCONFIG" = /dev/null
test "$UV_NO_CONFIG" = 1
mkdir -p "$prefix/bin" "$prefix/tools/node/lib/node_modules/openclaw"
printf '{"name":"openclaw","version":"%s"}' "$version" > "$prefix/tools/node/lib/node_modules/openclaw/package.json"
printf '#!/bin/sh\\necho %s\\n' "$version" > "$prefix/bin/openclaw"
chmod 755 "$prefix/bin/openclaw"
`;
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "preinstallation-test-"));
	roots.push(root);
	const home = join(root, "home"),
		state = join(root, "state"),
		installer = join(root, "installer.sh");
	mkdirSync(home);
	mkdirSync(state);
	writeFileSync(installer, script, { mode: 0o755 });
	const runtimeArtifact = join(root, "runtime.tgz");
	writeFileSync(runtimeArtifact, "fixture artifact");
	return {
		home,
		state,
		installer,
		runtimeArtifact,
		spec: {
			schemaVersion: "clawdi.runtime-preinstallation.v1",
			imageFingerprint: "a".repeat(64),
			architecture: process.arch,
			cliPackageSpec: `clawdi@${getCliVersion()}`,
			runtime: "openclaw",
			runtimeVersion: "2026.9.8",
			installerUrl: "https://openclaw.ai/install-cli.sh",
			runtimeTarballUrl: "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.8.tgz",
			runtimeIntegrity: `sha512-${createHash("sha512").update("fixture artifact").digest("base64")}`,
			installerSha256: createHash("sha256").update(script).digest("hex"),
			cliIntegrity: `sha512-${"A".repeat(86)}==`,
		},
	};
}
test("anonymous preparation installs without identity and seals actual health/content", () => {
	const f = fixture();
	const receipt = prepareRuntimePreinstallation(f.spec, f.installer, {
		...f,
		uid: process.getuid?.(),
		gid: process.getgid?.(),
	});
	expect(receipt.health).toBe("2026.9.8");
	const observation = observeRuntimeInstall(
		"openclaw",
		{
			enabled: true,
			services: {},
			install: {
				authority: "official",
				method: "official-installer",
				url: "https://openclaw.ai/install-cli.sh",
				home: f.home,
				args: ["--no-onboard"],
			},
		},
		f.home,
		getRuntimePaths({ mode: "hosted" }),
		{ uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
	);
	expect(observation.status).toBe("present");
	expect(observation.executedInstallerUrl).toBeNull();
	expect(receipt.homeTreeSha256).toBe(preinstallationTreeSha256(f.home));
	expect(JSON.parse(readFileSync(join(f.state, "preinstallation/receipt.json"), "utf8"))).toEqual(
		receipt,
	);
	expect(() => prepareRuntimePreinstallation(f.spec, f.installer, f)).toThrow("empty anonymous");
});
test("verified archive stays readable after root builder umask 077", () => {
	const f = fixture();
	const previous = process.umask(0o077);
	try {
		const receipt = prepareRuntimePreinstallation(f.spec, f.installer, {
			...f,
			uid: process.getuid?.(),
			gid: process.getgid?.(),
		});
		expect(receipt.health).toBe("2026.9.8");
	} finally {
		process.umask(previous);
	}
});
test("strict boundary rejects tenant identity, mutable versions, bad hashes and architecture", () => {
	const f = fixture();
	expect(preinstallationSpecSchema.safeParse({ ...f.spec, deploymentId: "tenant" }).success).toBe(
		false,
	);
	expect(preinstallationSpecSchema.safeParse({ ...f.spec, runtimeVersion: "latest" }).success).toBe(
		false,
	);
	expect(
		preinstallationSpecSchema.safeParse({ ...f.spec, runtime: "hermes", runtimeVersion: "main" })
			.success,
	).toBe(false);
	expect(() =>
		prepareRuntimePreinstallation({ ...f.spec, installerSha256: "b".repeat(64) }, f.installer, f),
	).toThrow("integrity");
	expect(() =>
		prepareRuntimePreinstallation(
			{ ...f.spec, architecture: process.arch === "x64" ? "arm64" : "x64" },
			f.installer,
			f,
		),
	).toThrow("architecture");
	writeFileSync(join(f.home, ".env"), "TENANT_TOKEN=secret");
	expect(() => prepareRuntimePreinstallation(f.spec, f.installer, f)).toThrow("empty anonymous");
});
test("installer environment excludes inherited credentials and tool configuration", () => {
	const env = anonymousInstallerEnvironment("/anonymous");
	expect(env).not.toHaveProperty("CLAWDI_AUTH_TOKEN");
	expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
	expect(env).not.toHaveProperty("GIT_CONFIG_COUNT");
	expect(env.PIP_CONFIG_FILE).toBe("/dev/null");
	expect(env.NPM_CONFIG_GLOBALCONFIG).toBe("/anonymous/.cache/anonymous-npm-globalrc");
});
test("content fingerprint detects package drift", () => {
	const f = fixture();
	writeFileSync(join(f.home, "software"), "original");
	const before = preinstallationTreeSha256(f.home);
	writeFileSync(join(f.home, "software"), "changed");
	expect(preinstallationTreeSha256(f.home)).not.toBe(before);
});

test.each([false, true])(
	"Hermes prebuild preserves defaults and rejects failure=%s",
	(failBuild) => {
		const f = fixture();
		const seed = join(f.home, "..", "upstream");
		mkdirSync(seed);
		mkdirSync(join(seed, "web"));
		writeFileSync(join(seed, "web", "package.json"), "{}\n");
		writeFileSync(join(seed, ".env.example"), "EXAMPLE_API_KEY=\n");
		writeFileSync(join(seed, "config.yaml"), "model:\n  provider: auto\n");
		writeFileSync(join(seed, "SOUL.md"), "Upstream persona.\n");
		for (const args of [
			["init", "-q"],
			["add", "."],
			[
				"-c",
				"user.name=Anonymous",
				"-c",
				"user.email=anonymous@example.invalid",
				"commit",
				"-qm",
				"fixture",
			],
		]) {
			const result = spawnSync("git", ["-C", seed, ...args], {
				env: anonymousInstallerEnvironment(f.home),
			});
			expect(result.status).toBe(0);
		}
		const commit = spawnSync("git", ["-C", seed, "rev-parse", "HEAD"], {
			env: anonymousInstallerEnvironment(f.home),
			encoding: "utf8",
		}).stdout.trim();
		const installer = `#!/bin/bash
set -eu
test "$#" = 6
test "$1" = --commit
test "$2" = '${commit}'
test "$3" = --force-commit
test "$4" = --skip-setup
test "$5" = --skip-browser
test "$6" = --non-interactive
mkdir -p "$HOME/.hermes/hermes-agent" "$HOME/.local/bin" "$HOME/.hermes/installs/generation/lib"
cp -a '${seed}/.' "$HOME/.hermes/hermes-agent"
cp '${seed}/SOUL.md' "$HOME/.hermes/SOUL.md"
cp '${seed}/.env.example' "$HOME/.hermes/.env"
cp '${seed}/config.yaml' "$HOME/.hermes/config.yaml"
printf '#!/bin/sh\\nif [ "$*" = "config path" ]; then echo "$HOME/.hermes/config.yaml"; else echo Hermes-fixture; fi\\n' > "$HOME/.local/bin/hermes"
chmod 755 "$HOME/.local/bin/hermes"
cat > "$HOME/.local/bin/npm" <<'NPM'
#!/bin/sh
set -eu
${failBuild ? "exit 1" : ":"}
printf '%s\\n' "$*" >> "$HOME/npm-build.log"
if [ "$*" = 'run build' ]; then
  mkdir -p ../hermes_cli/web_dist
  echo '<html>dashboard</html>' > ../hermes_cli/web_dist/index.html
fi
NPM
chmod 755 "$HOME/.local/bin/npm"
`;
		writeFileSync(f.installer, installer);
		const { runtimeIntegrity: _integrity, runtimeTarballUrl: _url, ...base } = f.spec;
		const prepare = () =>
			prepareRuntimePreinstallation(
				{
					...base,
					runtime: "hermes",
					runtimeVersion: commit,
					installerUrl: `https://raw.githubusercontent.com/NousResearch/hermes-agent/${commit}/scripts/install.sh`,
					installerSha256: createHash("sha256").update(installer).digest("hex"),
				},
				f.installer,
				{ ...f, uid: process.getuid?.(), gid: process.getgid?.() },
			);
		if (failBuild) {
			expect(prepare).toThrow(
				"anonymous runtime installation or health check failed (npm, exit 1)",
			);
			expect(existsSync(join(f.state, "preinstallation/receipt.json"))).toBe(false);
			expect(
				existsSync(
					join(
						f.home,
						".hermes/hermes-agent/hermes_cli/web_dist",
						HERMES_DASHBOARD_BUILD_REVISION_FILE,
					),
				),
			).toBe(false);
			return;
		}
		const receipt = prepare();
		expect(receipt.health).toBe("Hermes-fixture");
		expect(receipt.probes).toMatchObject({
			sourceIdentity: `git:${commit}`,
			configPath: join(f.home, ".hermes/config.yaml"),
			version: "Hermes-fixture",
		});
		const command = join(f.home, ".local/bin/hermes");
		const revision = runtimeCommandCurrentRevision(command, f.home, f.home);
		const marker = join(
			f.home,
			".hermes/hermes-agent/hermes_cli/web_dist",
			HERMES_DASHBOARD_BUILD_REVISION_FILE,
		);
		if (!revision) throw new Error("Hermes revision is missing");
		expect(readFileSync(marker, "utf8").trim()).toBe(revision);
		expect(readFileSync(join(f.home, "npm-build.log"), "utf8").trim().split("\n")).toEqual([
			"ci --include=dev --workspace web",
			"run build",
		]);
		prepareHermesDashboardBuild({
			home: f.home,
			revision,
			run() {
				throw new Error("prebuilt dashboard must not rebuild");
			},
			writeRevision() {
				throw new Error("prebuilt dashboard must not rewrite marker");
			},
		});
		for (const [name, example] of [
			["SOUL.md", "SOUL.md"],
			[".env", ".env.example"],
			["config.yaml", "config.yaml"],
		])
			expect(readFileSync(join(f.home, ".hermes", name))).toEqual(
				readFileSync(join(seed, example)),
			);
	},
);
