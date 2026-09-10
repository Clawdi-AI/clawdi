import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { NATIVE_TARGETS } from "../../src/lib/native-release-manifest.ts";
import {
	installBuiltinMcp,
	planBuiltinMcp,
	verifyBuiltinMcpAccess,
} from "../../src/runtime/builtin-mcp.ts";
import { hostedRuntimeBundleV2Schema } from "../../src/runtime/manifest-source.ts";
import { getRuntimePaths } from "../../src/runtime/paths.ts";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = mkdtempSync("/tmp/vault-upgrade-");
chmodSync(root, 0o755);
const archive = readFileSync("/artifacts/old.tar.gz");
assert.equal(hash(archive), "50e6c64fc67ec4786ca160cb5d6da7c359c0a8f37d73fe85b2612cb728958533");
const oldManifest = readFileSync("/artifacts/old-manifest.txt");
assert.equal(hash(oldManifest), "f102cccdc21b54012801bfce9d0011d1f031f1e8fa28b973902022e6b806f4fa");
const version = JSON.parse(readFileSync("/repo/packages/cli/package.json", "utf8")).version;
const prefix = join(root, "private-prefix");
const stage = join(prefix, "share/clawdi/.stage-initial");
mkdirSync(stage, { recursive: true, mode: 0o700 });
chmodSync(prefix, 0o700);
const env = {
	...process.env,
	HOME: join(root, "admin-home"),
	CLAWDI_HOME: join(root, "admin-state"),
	CLAWDI_RUNTIME_MODE: "local",
};
delete env.CLAWDI_NO_AUTO_UPDATE;
delete env.CLAWDI_NO_UPDATE_CHECK;
mkdirSync(env.HOME, { mode: 0o700 });
mkdirSync(env.CLAWDI_HOME, { mode: 0o700 });

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const { input = "", ...childOptions } = options;
		const child = spawn(command, args, { env, timeout: 90_000, stdio: "pipe", ...childOptions });
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (data) => {
			stdout += data;
		});
		child.stderr.on("data", (data) => {
			stderr += data;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input);
	});
}
async function success(command, args, options) {
	const result = await run(command, args, options);
	assert.equal(result.code, 0, `${command}: ${result.stderr}`);
	return result.stdout.trim();
}

let server;
try {
	await success("tar", ["-xzf", "/artifacts/old.tar.gz", "-C", stage]);
	writeFileSync(join(stage, "clawdi-cli-manifest.txt"), oldManifest);
	assert.equal(await success(join(stage, "clawdi"), ["--version"]), "0.14.68");
	await success(join(stage, "clawdi"), [
		"update",
		"--native-activate",
		"--native-stage",
		stage,
		"--native-prefix",
		prefix,
		"--native-version",
		"0.14.68",
		"--native-target",
		"linux-x64",
	]);
	const launcher = join(prefix, "bin/clawdi");
	const oldBinary = realpathSync(launcher);
	const candidate = readFileSync("/artifacts/candidate.tar.gz");
	const inventory = await success("tar", ["-tzf", "/artifacts/candidate.tar.gz"]);
	assert.deepEqual([...new Set(inventory.split("\n").map((path) => path.split("/")[0]))].sort(), [
		"clawdi",
		"egress-addon",
		"skills",
	]);

	// A correctly checksummed archive with a forbidden new top-level entry must
	// still fail in the OLD executable; this is not a replacement validator test.
	const badRoot = join(root, "bad");
	mkdirSync(badRoot);
	await success("tar", ["-xzf", "/artifacts/candidate.tar.gz", "-C", badRoot]);
	mkdirSync(join(badRoot, "runtime-mcp"));
	writeFileSync(join(badRoot, "runtime-mcp/index.js"), "// deliberately forbidden fixture\n");
	const badPath = join(root, "bad.tar.gz");
	await success("tar", [
		"-czf",
		badPath,
		"-C",
		badRoot,
		"clawdi",
		"egress-addon",
		"skills",
		"runtime-mcp",
	]);
	let served = readFileSync(badPath);
	const cert = join(root, "cert.pem"),
		key = join(root, "key.pem");
	await success("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		key,
		"-out",
		cert,
		"-days",
		"1",
		"-subj",
		"/CN=github.com",
		"-addext",
		"subjectAltName=DNS:github.com",
	]);
	const requests = [];
	server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
		requests.push(req.url);
		const base = `/Clawdi-AI/clawdi/releases/download/clawdi-cli-v${version}/`;
		if (req.url === `${base}clawdi-cli-manifest.txt`) {
			res.end(
				[
					"clawdi.nativeRelease.v1",
					`version\t${version}`,
					...NATIVE_TARGETS.map(
						(target) =>
							`artifact\t${target}\tclawdi-cli-${target}.tar.gz\t${target === "linux-x64" ? hash(served) : "0".repeat(64)}`,
					),
					"",
				].join("\n"),
			);
		} else if (req.url === `${base}clawdi-cli-linux-x64.tar.gz`) res.end(served);
		else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(443, "0.0.0.0", resolve);
	});
	const updateEnv = { ...env, NODE_EXTRA_CA_CERTS: cert, SSL_CERT_FILE: cert };
	const updateArgs = [
		"update",
		"--background-worker",
		"--current-version",
		"0.14.68",
		"--channel",
		"latest",
		"--latest",
		version,
	];
	assert.equal((await run(oldBinary, updateArgs, { env: updateEnv })).code, 1);
	assert.equal(await success(launcher, ["--version"]), "0.14.68");
	assert.equal(requests.length, 2, "old updater must fetch and reject the checksummed bad archive");
	served = candidate;
	await success(oldBinary, updateArgs, { env: updateEnv });
	assert.equal(await success(launcher, ["--version"]), version);
	assert.notEqual(realpathSync(launcher), oldBinary);
	assert.equal(requests.length, 4, "old updater must fetch and activate the real candidate");
	console.log(
		`Published native 0.14.68 -> ${version}: old download/checksum/allowlist and new activation passed; forbidden archive rejected.`,
	);

	// The real tenant identity must traverse the package ancestors and execute
	// the image's shared Node path for both native runtime configurations.
	process.env.CLAWDI_RUNTIME_USER = "clawdi-test";
	const fixture = hostedRuntimeBundleV2Schema.parse(
		JSON.parse(readFileSync("/repo/test-fixtures/runtime-bundle-v2.golden.json", "utf8")),
	);
	for (const runtime of ["openclaw", "hermes"]) {
		const home = join(root, runtime);
		mkdirSync(home, { mode: 0o700 });
		chownSync(home, 1000, 1000);
		const workspace = join(home, "workspace");
		mkdirSync(workspace, { mode: 0o700 });
		chownSync(workspace, 1000, 1000);
		const paths = { ...getRuntimePaths(), serviceStateRoot: join(root, "state") };
		const plan = planBuiltinMcp(
			{ ...fixture.manifest, environmentId: "20000000-0000-4000-8000-000000000002" },
			paths,
			{
				url: "https://cloud.example/v1/mcp/clawdi",
				transport: "streamable-http",
				localVault: 1,
				headers: { Authorization: { secretRef: "secret://clawdi/auth-token", prefix: "Bearer " } },
			},
			workspace,
		);
		installBuiltinMcp(plan);
		verifyBuiltinMcpAccess(plan, home, workspace);
		chmodSync(join(root, "clawdi-mcp"), 0o700);
		assert.throws(() => verifyBuiltinMcpAccess(plan, home, workspace), /traversable ancestors/);
		chmodSync(join(root, "clawdi-mcp"), 0o755);
		assert.throws(
			() =>
				verifyBuiltinMcpAccess(
					{ ...plan, server: { ...plan.server, command: "/missing-node" } },
					home,
					workspace,
				),
			/Node 24/,
		);
		const response = await success(plan.server.command, plan.server.args, {
			uid: 1000,
			gid: 1000,
			cwd: workspace,
			env: { PATH: "/usr/bin:/bin", HOME: home, ...plan.server.env },
			input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tenant-proof", version: "1" } } })}\n`,
		});
		assert.equal(JSON.parse(response).result.serverInfo.name, "clawdi");
		assert.equal(
			await success(
				"/usr/local/bin/node",
				[
					"-e",
					'const fs=require("fs"); try {fs.accessSync(process.argv[1],fs.constants.X_OK);process.exit(1)} catch {}',
					launcher,
				],
				{ uid: 1000, gid: 1000 },
			),
			"",
		);
		console.log(
			`${runtime}: tenant UID 1000 launched MCP via ${plan.server.command}; private management CLI inaccessible; blocked ancestors and missing Node rejected.`,
		);
	}
} finally {
	if (server) await new Promise((resolve) => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
