import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpenClawAdapter } from "./openclaw";
import {
	resolveOpenClawAgentWorkspace,
	resolveOpenClawAgentWorkspaceAsync,
} from "./openclaw-workspace";

const originalEnv = { ...process.env };
const originalGetuid = process.getuid;
if (process.env.CLAWDI_TEST_OPENCLAW_REQUIRE_ROOT === "1" && process.geteuid?.() !== 0) {
	throw new Error("OpenClaw ownership regression requires a root test process");
}
let root = "";
afterEach(() => {
	Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
	process.env = { ...originalEnv };
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

function commandFixture(runtimeUser: string | undefined, installedBin = ".local") {
	root = mkdtempSync(join(tmpdir(), "openclaw-runtime-user-"));
	chmodSync(root, 0o755);
	const bin = join(root, "bin");
	const tenantBin = join(root, installedBin, "bin");
	const workspace = join(root, "workspace");
	const log = join(root, "commands.log");
	const dropLog = join(root, "privilege-drop.log");
	const stagingLog = join(root, "staging.log");
	const runsAsRoot = process.geteuid?.() === 0;
	const privilegeDropBinary = ["set", "priv"].join("");
	const uid = runsAsRoot ? 65534 : (originalGetuid?.() ?? 1000);
	const gid = runsAsRoot ? 65534 : (process.getgid?.() ?? 1000);
	for (const directory of [bin, tenantBin, workspace]) mkdirSync(directory, { recursive: true });
	chmodSync(workspace, 0o777);
	for (const path of [log, dropLog, stagingLog]) {
		writeFileSync(path, "");
		chmodSync(path, 0o666);
	}
	writeFileSync(
		join(bin, privilegeDropBinary),
		`#!/bin/sh
set -eu
printf '%s\\n' "$*" >> '${dropLog}'
export CLAWDI_TEST_PRIVILEGE_DROPPED=1
${runsAsRoot ? `exec /usr/bin/${privilegeDropBinary} "$@"` : 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"'}
`,
		{ mode: 0o755 },
	);
	const command = `#!/bin/sh
set -eu
printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n' "$0" "\${CLAWDI_TEST_PRIVILEGE_DROPPED:-}" "\${OPENCLAW_STATE_DIR:-}" "\${OPENCLAW_CONFIG_PATH:-}" "$HOME" "\${USER:-}" "$PATH" "$*" "$(id -u)" "$(pwd)" >> '${log}'
if test "$1 $2 $3" = "agents list --json"; then
  printf '[{"id":"main","workspace":"${workspace}"}]\\n'
  exit 0
fi
test "$1 $2" = "skills install"
${
	runsAsRoot
		? `if test "\${CLAWDI_TEST_PRIVILEGE_DROPPED:-}" = "1"; then
  find "$(dirname "$3")" -exec sh -c '
    for path do
      test ! -w "$path" || exit 98
      stat -c "%u|%a|%F|%n" "$path"
    done
  ' sh {} + >> '${stagingLog}'
fi`
		: ""
}
mkdir -p '${workspace}/skills'
cp -R "$3" '${workspace}/skills/'"$7"
if test "\${CLAWDI_TEST_INSTALL_STATUS:-0}" != "0"; then
  printf 'fixture install failure\\n' >&2
  exit "$CLAWDI_TEST_INSTALL_STATUS"
fi
`;
	const installedCommand = join(tenantBin, "openclaw");
	writeFileSync(installedCommand, command, { mode: 0o755 });
	const pathCommand = join(bin, "openclaw");
	writeFileSync(pathCommand, command, { mode: 0o755 });
	process.env.HOME = root;
	process.env.PATH = `${bin}:/usr/local/bin:/usr/bin:/bin`;
	process.env.CLAWDI_RUNTIME_UID = String(uid);
	process.env.CLAWDI_RUNTIME_GID = String(gid);
	process.env.OPENCLAW_STATE_DIR = join(root, "custom-state");
	process.env.OPENCLAW_CONFIG_PATH = join(root, "custom-config.json");
	delete process.env.OPENCLAW_AGENT_ID;
	delete process.env.CLAWDI_TEST_PRIVILEGE_DROPPED;
	delete process.env.CLAWDI_TEST_INSTALL_STATUS;
	if (runtimeUser === undefined) delete process.env.CLAWDI_RUNTIME_USER;
	else process.env.CLAWDI_RUNTIME_USER = runtimeUser;
	// The clean runner is unprivileged; exercise the root parent's command resolution there.
	Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
	return { workspace, log, dropLog, stagingLog, installedCommand, pathCommand, uid, runsAsRoot };
}

function skillArchive(content = "# Review PR\n"): Buffer {
	const source = join(root, "source", "review-pr");
	const nested = join(source, "references");
	const scripts = join(source, "scripts");
	mkdirSync(nested, { recursive: true });
	mkdirSync(scripts, { recursive: true });
	chmodSync(source, 0o700);
	chmodSync(nested, 0o700);
	chmodSync(scripts, 0o700);
	writeFileSync(join(source, "SKILL.md"), content, { mode: 0o600 });
	writeFileSync(join(nested, "guide.md"), "# Guide\n", { mode: 0o600 });
	writeFileSync(join(scripts, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const archive = join(root, "review-pr.tar.gz");
	const packed = spawnSync("tar", ["-czf", archive, "-C", dirname(source), "review-pr"]);
	if (packed.status !== 0) throw new Error("test tar creation failed");
	return readFileSync(archive);
}

function expectTenantOwnedTree(path: string, uid: number): void {
	const node = lstatSync(path);
	expect(node.uid).not.toBe(0);
	expect(node.uid).toBe(uid);
	if (node.isDirectory()) {
		for (const name of readdirSync(path)) expectTenantOwnedTree(join(path, name), uid);
	}
}

function expectCleanedInstallStaging(log: string): void {
	for (const call of readFileSync(log, "utf8").trim().split("\n")) {
		const args = call.split("|")[7];
		if (args?.startsWith("skills install ")) {
			const source = args.split(" ")[2];
			expect(source).toBeDefined();
			expect(existsSync(dirname(source ?? ""))).toBe(false);
		}
	}
}

test.each([".local", ".openclaw"])(
	"runs synchronous workspace discovery and Skill pulls through the runtime user (%s)",
	async (installedBin) => {
		const fixture = commandFixture("fixture-agent", installedBin);
		const adapter = new OpenClawAdapter();
		expect(adapter.skills.rootDir()).toBe(join(fixture.workspace, "skills"));
		expect(await resolveOpenClawAgentWorkspaceAsync()).toBe(fixture.workspace);
		const archive = skillArchive();
		await adapter.skills.writeArchive("review-pr", archive);
		await adapter.skills.writeSharedArchive("review-pr", "alice-a3b4", archive);
		for (const slug of ["review-pr", "review-pr__alice-a3b4"]) {
			const target = join(fixture.workspace, "skills", slug);
			expect(readFileSync(join(target, "references", "guide.md"), "utf8")).toBe("# Guide\n");
			expectTenantOwnedTree(target, fixture.uid);
			expect(statSync(join(target, "SKILL.md")).mode & 0o777).toBe(0o644);
			expect(statSync(join(target, "scripts", "run.sh")).mode & 0o777).toBe(0o755);
		}
		expectTenantOwnedTree(join(fixture.workspace, "skills"), fixture.uid);
		const calls = readFileSync(fixture.log, "utf8").trim().split("\n");
		expect(calls).toHaveLength(8);
		for (const call of calls) {
			const [command, marker, state, config, home, user, path, , uid, cwd] = call.split("|");
			expect(command).toBe(fixture.installedCommand);
			expect(marker).toBe("1");
			expect(state).toBe(process.env.OPENCLAW_STATE_DIR ?? "");
			expect(config).toBe(process.env.OPENCLAW_CONFIG_PATH ?? "");
			expect(home).toBe(root);
			expect(user).toBe("fixture-agent");
			expect(path).toBe(process.env.PATH ?? "");
			expect(uid).toBe(String(fixture.uid));
			expect(cwd).toBe(root);
		}
		expectCleanedInstallStaging(fixture.log);
		if (fixture.runsAsRoot) {
			const nodes = readFileSync(fixture.stagingLog, "utf8").trim().split("\n");
			expect(nodes).toHaveLength(14);
			for (const node of nodes) {
				const [uid, mode, type, path] = node.split("|");
				expect(uid).toBe("0");
				expect(mode).toBe(type === "directory" || path?.endsWith("run.sh") ? "755" : "644");
			}
		}
		const drops = readFileSync(fixture.dropLog, "utf8").trim().split("\n");
		expect(drops).toHaveLength(calls.length);
		for (const drop of drops) {
			expect(drop).toContain(`--reuid=${fixture.uid}`);
			expect(drop).toContain(`${fixture.installedCommand} `);
		}
	},
);

test("reports a runtime-user installer failure and restores the old tenant-owned target", async () => {
	const fixture = commandFixture("fixture-agent");
	const adapter = new OpenClawAdapter();
	await adapter.skills.writeArchive("review-pr", skillArchive());
	process.env.CLAWDI_TEST_INSTALL_STATUS = "23";
	await expect(
		adapter.skills.writeArchive("review-pr", skillArchive("# Replacement\n")),
	).rejects.toThrow("OpenClaw official Skill install failed: fixture install failure");
	const target = join(fixture.workspace, "skills", "review-pr");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Review PR\n");
	expect(readFileSync(join(target, "references", "guide.md"), "utf8")).toBe("# Guide\n");
	expectTenantOwnedTree(join(fixture.workspace, "skills"), fixture.uid);
	expect(readdirSync(join(fixture.workspace, "skills"))).toEqual(["review-pr"]);
	expectCleanedInstallStaging(fixture.log);
	const installers = readFileSync(fixture.log, "utf8")
		.trim()
		.split("\n")
		.filter((call) => call.split("|")[7]?.startsWith("skills install "));
	expect(installers).toHaveLength(2);
	for (const installer of installers) {
		const [command, marker, , , , , , , uid, cwd] = installer.split("|");
		expect(command).toBe(fixture.installedCommand);
		expect(marker).toBe("1");
		expect(uid).toBe(String(fixture.uid));
		expect(cwd).toBe(root);
	}
});

test("leaves unset OpenClaw location overrides unset for both synchronous calls", async () => {
	const fixture = commandFixture("fixture-agent");
	delete process.env.OPENCLAW_STATE_DIR;
	delete process.env.OPENCLAW_CONFIG_PATH;
	expect(resolveOpenClawAgentWorkspace()).toBe(fixture.workspace);
	await new OpenClawAdapter().skills.writeArchive("review-pr", skillArchive());
	for (const call of readFileSync(fixture.log, "utf8").trim().split("\n")) {
		expect(call.split("|").slice(1, 4)).toEqual(["1", "", ""]);
	}
});

test.each([undefined, "root"])(
	"preserves PATH command selection and environment for BYO (runtime user: %s)",
	async (runtimeUser) => {
		const fixture = commandFixture(runtimeUser);
		expect(resolveOpenClawAgentWorkspace()).toBe(fixture.workspace);
		await new OpenClawAdapter().skills.writeArchive("review-pr", skillArchive());
		expect(readFileSync(fixture.dropLog, "utf8")).toBe("");
		for (const call of readFileSync(fixture.log, "utf8").trim().split("\n")) {
			const [command, marker, state, config, home, user, path, , , cwd] = call.split("|");
			expect(command).toBe(fixture.pathCommand);
			expect(marker).toBe("");
			expect(state).toBe(process.env.OPENCLAW_STATE_DIR ?? "");
			expect(config).toBe(process.env.OPENCLAW_CONFIG_PATH ?? "");
			expect(home).toBe(root);
			expect(user).toBe(process.env.USER ?? "");
			expect(path).toBe(process.env.PATH ?? "");
			expect(cwd).toBe(process.cwd());
		}
	},
);

test.each(["missing executable", "nonzero exit"])(
	"preserves the synchronous workspace error with a runtime user (%s)",
	(failure) => {
		const fixture = commandFixture("fixture-agent");
		if (failure === "missing executable") rmSync(fixture.installedCommand);
		else
			writeFileSync(
				fixture.installedCommand,
				"#!/bin/sh\necho fixture-sensitive-output\nexit 23\n",
			);
		expect(() => new OpenClawAdapter().skills.rootDir()).toThrow(
			"OpenClaw workspace resolution requires `openclaw agents list --json`",
		);
	},
);
