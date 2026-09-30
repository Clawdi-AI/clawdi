import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acknowledgeHermesManagedEnvironment,
	HERMES_MANAGED_ENV_HELPER,
	hermesManagedProfileEnvironment,
	reconcileHermesManagedEnvironment,
} from "./hermes-managed-env";
import type { RuntimeManifest } from "./manifest-contract";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const venv = process.env.CLAWDI_TEST_HERMES_VENV;
	if (!venv) throw new Error("Native Hermes fixture is required");
	const home = mkdtempSync(join(tmpdir(), "hermes-profile-env-"));
	roots.push(home);
	const app = join(home, ".hermes", "hermes-agent");
	mkdirSync(app, { recursive: true });
	symlinkSync(venv, join(app, "venv"));
	const envPath = join(home, ".hermes", ".env");
	const secondary = join(home, ".hermes", "profiles", "support", ".env");
	mkdirSync(join(home, ".hermes", "profiles", "support"), { recursive: true });
	writeFileSync(envPath, "# user settings\nUSER_PREFERENCE=preserved\n", { mode: 0o600 });
	writeFileSync(secondary, "CLAWDI_AI_API_KEY=secondary-private\n", { mode: 0o600 });
	const run = (desired: Record<string, string>, prefix = "") =>
		spawnSync(join(venv, "bin", "python"), ["-c", prefix + HERMES_MANAGED_ENV_HELPER, app], {
			input: JSON.stringify(desired),
			encoding: "utf8",
			timeout: 15_000,
			env: {
				...process.env,
				HOME: home,
				HERMES_HOME: join(home, ".hermes"),
				PYTHONDONTWRITEBYTECODE: "1",
			},
		});
	return {
		home,
		app,
		envPath,
		secondary,
		run,
		acknowledge: () => acknowledgeHermesManagedEnvironment({ home, workspaceRoot: home }),
		receipt: join(home, ".clawdi", "runtime", "hermes-managed-env.json"),
		python: join(venv, "bin", "python"),
	};
}

test("native profile credentials survive reloads and multiplex without reaching secondary profiles", () => {
	const f = fixture();
	const desired = {
		DISCORD_BOT_TOKEN: "egress-channel-one",
		CLAWDI_AI_API_KEY: "clawdi-egress-placeholder",
		DISCORD_ALLOW_ALL_USERS: "true",
	};
	expect(
		reconcileHermesManagedEnvironment({ home: f.home, workspaceRoot: f.home, desired }),
	).toEqual({ changed: true, conflicts: [] });
	expect(f.run(desired).status).toBe(0);
	const verify = spawnSync(
		f.python,
		[
			"-c",
			`
import os
from pathlib import Path
from hermes_cli.env_loader import load_hermes_dotenv
from agent.secret_scope import build_profile_secret_scope, set_multiplex_active, set_secret_scope, get_secret
home=Path(os.environ["HERMES_HOME"])
for _ in range(2):
    os.environ["DISCORD_BOT_TOKEN"]="stale-inherited-value"
    load_hermes_dotenv(hermes_home=home, load_external_secrets=False)
    assert os.environ["DISCORD_BOT_TOKEN"] == "egress-channel-one"
set_multiplex_active(True)
set_secret_scope(build_profile_secret_scope(home))
assert get_secret("DISCORD_BOT_TOKEN") == "egress-channel-one"
assert get_secret("CLAWDI_AI_API_KEY") == "clawdi-egress-placeholder"
set_secret_scope(build_profile_secret_scope(home / "profiles" / "support"))
assert get_secret("DISCORD_BOT_TOKEN") is None
assert get_secret("CLAWDI_AI_API_KEY") == "secondary-private"
`,
		],
		{
			encoding: "utf8",
			env: { ...process.env, HOME: f.home, HERMES_HOME: join(f.home, ".hermes") },
			timeout: 15_000,
		},
	);
	if (verify.status !== 0) throw new Error(`Native profile resolution failed: ${verify.stderr}`);
	expect(readFileSync(f.envPath, "utf8")).toContain("# user settings\nUSER_PREFERENCE=preserved\n");
	expect(readFileSync(f.secondary, "utf8")).toBe("CLAWDI_AI_API_KEY=secondary-private\n");
	expect(statSync(f.envPath).mode & 0o777).toBe(0o600);
	expect(readFileSync(f.receipt, "utf8")).not.toContain("egress-channel-one");
});

test("native ownership rotates, adopts emergency placeholders, unlinks only owned slots, and stays idempotent", () => {
	const f = fixture();
	writeFileSync(f.envPath, "USER_PREFERENCE=preserved\nDISCORD_BOT_TOKEN=egress-one\n");
	const initial = f.run({ DISCORD_BOT_TOKEN: "egress-one" });
	expect(JSON.parse(initial.stdout)).toEqual({ changed: false, conflicts: [] });
	const receiptTime = statSync(f.receipt).mtimeMs;
	expect(JSON.parse(f.run({ DISCORD_BOT_TOKEN: "egress-one" }).stdout).changed).toBe(false);
	expect(statSync(f.receipt).mtimeMs).toBe(receiptTime);
	expect(JSON.parse(f.run({ DISCORD_BOT_TOKEN: "egress-two" }).stdout).changed).toBe(true);
	expect(readFileSync(f.envPath, "utf8")).toContain("DISCORD_BOT_TOKEN=egress-two");
	expect(JSON.parse(f.run({ DISCORD_BOT_TOKEN: "egress-two" }).stdout).changed).toBe(true);
	f.acknowledge();
	expect(JSON.parse(f.run({ DISCORD_BOT_TOKEN: "egress-two" }).stdout).changed).toBe(false);
	expect(JSON.parse(f.run({}).stdout).changed).toBe(true);
	expect(readFileSync(f.envPath, "utf8")).toBe("USER_PREFERENCE=preserved\n");
	expect(JSON.parse(f.run({}).stdout).changed).toBe(true);
	f.acknowledge();
	expect(existsSync(f.receipt)).toBe(false);
});

test("unowned and subsequently edited credentials are preserved and conflicts contain no values", () => {
	const f = fixture();
	writeFileSync(f.envPath, "DISCORD_BOT_TOKEN=user-private\n");
	const conflict = f.run({ DISCORD_BOT_TOKEN: "managed-private" });
	expect(JSON.parse(conflict.stdout)).toEqual({ changed: false, conflicts: ["DISCORD_BOT_TOKEN"] });
	expect(conflict.stdout + conflict.stderr).not.toContain("private");
	expect(readFileSync(f.envPath, "utf8")).toBe("DISCORD_BOT_TOKEN=user-private\n");
	writeFileSync(f.envPath, "");
	expect(f.run({ DISCORD_BOT_TOKEN: "managed-private" }).status).toBe(0);
	writeFileSync(f.envPath, "DISCORD_BOT_TOKEN=new-user-private\n");
	expect(f.run({}).status).toBe(0);
	expect(readFileSync(f.envPath, "utf8")).toBe("DISCORD_BOT_TOKEN=new-user-private\n");
});

test.each([false, true])(
	"a failure after native persistence keeps retry ownership (rotation: %s)",
	(rotation) => {
		const f = fixture();
		if (rotation) expect(f.run({ DISCORD_BOT_TOKEN: "egress-old" }).status).toBe(0);
		const fail = f.run(
			{ DISCORD_BOT_TOKEN: "egress-new" },
			`
from hermes_cli import config
original = config.save_env_value
def fail_after_write(key, value):
    original(key, value)
    raise RuntimeError("private diagnostic " + value)
config.save_env_value = fail_after_write
`,
		);
		expect(fail.status).toBe(1);
		expect(fail.stdout + fail.stderr).toBe("");
		expect(JSON.parse(f.run({ DISCORD_BOT_TOKEN: "egress-new" }).stdout).changed).toBe(true);
		expect(JSON.parse(f.run({}).stdout).changed).toBe(true);
	},
);

test("failed native removal remains pending until a successful refresh", () => {
	const f = fixture();
	expect(f.run({ DISCORD_BOT_TOKEN: "egress-one" }).status).toBe(0);
	f.acknowledge();
	const failed = f.run(
		{},
		`
from hermes_cli import config
original = config.remove_env_value
def fail_after_remove(key):
    original(key)
    raise RuntimeError("private diagnostic")
config.remove_env_value = fail_after_remove
`,
	);
	expect(failed.status).toBe(1);
	expect(failed.stdout + failed.stderr).toBe("");
	expect(JSON.parse(f.run({}).stdout).changed).toBe(true);
	f.acknowledge();
	expect(existsSync(f.receipt)).toBe(false);
});

test("native write locks and symlinked profiles refuse writes without changing user data", () => {
	const f = fixture();
	const original = readFileSync(f.envPath, "utf8");
	const refused = f.run(
		{ DISCORD_BOT_TOKEN: "egress-one" },
		`
from hermes_cli import config
def refuse(key, action):
    raise ValueError("private managed write lock")
config.require_env_writable = refuse
`,
	);
	expect(refused.status).toBe(1);
	expect(refused.stdout + refused.stderr).toBe("");
	expect(readFileSync(f.envPath, "utf8")).toBe(original);
	expect(existsSync(f.receipt)).toBe(false);
	rmSync(f.envPath);
	symlinkSync(f.secondary, f.envPath);
	expect(f.run({ DISCORD_BOT_TOKEN: "egress-one" }).status).toBe(1);
	expect(readFileSync(f.secondary, "utf8")).toBe("CLAWDI_AI_API_KEY=secondary-private\n");
});

test("a user edit after failed persistence releases pending ownership without repeated refresh", () => {
	const f = fixture();
	expect(
		f.run(
			{ DISCORD_BOT_TOKEN: "egress-one" },
			`
from hermes_cli import config
original = config.save_env_value
def fail_after_write(key, value):
    original(key, value)
    raise RuntimeError("private diagnostic")
config.save_env_value = fail_after_write
`,
		).status,
	).toBe(1);
	writeFileSync(f.envPath, "DISCORD_BOT_TOKEN=user-edited\n");
	expect(JSON.parse(f.run({ DISCORD_BOT_TOKEN: "egress-one" }).stdout)).toEqual({
		changed: true,
		conflicts: ["DISCORD_BOT_TOKEN"],
	});
	f.acknowledge();
	expect(JSON.parse(f.run({ DISCORD_BOT_TOKEN: "egress-one" }).stdout)).toEqual({
		changed: false,
		conflicts: ["DISCORD_BOT_TOKEN"],
	});
	expect(readFileSync(f.envPath, "utf8")).toBe("DISCORD_BOT_TOKEN=user-edited\n");
});

test("symlinked ownership directories are rejected before creating any external files", () => {
	const f = fixture();
	const target = join(f.home, ".hermes", "profiles", "support");
	symlinkSync(target, join(f.home, ".clawdi"));
	const refused = f.run({ DISCORD_BOT_TOKEN: "egress-one" });
	expect(refused.status).toBe(1);
	expect(refused.stdout + refused.stderr).toBe("");
	expect(existsSync(join(target, "runtime"))).toBe(false);
});

test("profile environment projection includes only platform-owned provider/channel fields", () => {
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "dep_test",
		environmentId: "env_test",
		instanceId: "iid_test",
		generation: 1,
		issuedAt: "2026-09-30T00:00:00Z",
		controlPlane: { apiUrl: "https://api.test" },
		runtimes: {
			hermes: {
				enabled: true,
				services: {},
				run: {
					prependPath: [],
					env: { DISCORD_ALLOW_ALL_USERS: "true", USER_PREFERENCE: "preserved" },
					secretEnv: {
						DISCORD_BOT_TOKEN: "secret://discord",
						UNRELATED_TOKEN: "secret://unrelated",
					},
				},
			},
		},
		projection: { channels: { discord: { accounts: { one: { enabled: true } } } } },
		recovery: {},
	};
	expect(
		hermesManagedProfileEnvironment(manifest, { "secret://discord": "egress-placeholder" }),
	).toEqual({ DISCORD_BOT_TOKEN: "egress-placeholder", DISCORD_ALLOW_ALL_USERS: "true" });
	manifest.projection = { channels: {} };
	expect(hermesManagedProfileEnvironment(manifest, {})).toEqual({});
});
