import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import {
	uninstallWindowsTask,
	windowsTaskInstalled,
	windowsTaskRunning,
} from "../../../packages/cli/src/serve/windows-task";
import {
	desktopReleaseBuilderArgs,
	readDesktopReleaseConfiguration,
} from "../src/release-contract";

if (process.platform !== "win32" || process.arch !== "x64")
	throw new Error("Windows update e2e requires native Windows x64.");
// Only run in a disposable CI account. Never replace another user's Sync task.
if (windowsTaskInstalled()) throw new Error("Refusing to replace an existing Clawdi Sync task.");
const desktopRoot = resolve(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "clawdi-windows-update-"));
const home = join(root, "home");
const cliRoot = join(home, ".clawdi");
const installed = join(root, "installed");
for (const directory of [home, join(root, "userData"), join(root, "local")]) mkdirSync(directory);
const children = new Set<ChildProcess>();
let server: ReturnType<typeof createServer> | undefined;
let taskCreated = false;
let installedApp = false;
const env = {
	...process.env,
	LOCALAPPDATA: join(root, "local"),
	CLAWDI_HOME: cliRoot,
	CLAWDI_DESKTOP_UPDATE_E2E_ROOT: root,
	CLAWDI_DESKTOP_UPDATE_E2E_CLI_LOG: join(root, "cli.log"),
	ELECTRON_BUILDER_CACHE: join(root, "builder-cache"),
	ELECTRON_CACHE: join(root, "electron-cache"),
	CSC_IDENTITY_AUTO_DISCOVERY: "false",
};

async function run(
	command: string,
	args: string[],
	timeout = 180_000,
	extraEnv: Record<string, string> = {},
): Promise<void> {
	const child = spawn(command, args, {
		cwd: desktopRoot,
		env: { ...env, ...extraEnv },
		stdio: "inherit",
	});
	children.add(child);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid) {
			const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
			});
			killer.on("error", (error) =>
				console.error("Could not kill timed-out Windows e2e process", error),
			);
		}
	}, timeout);
	try {
		const [code, signal] = await once(child, "exit");
		if (timedOut || code !== 0)
			throw new Error(`${command} failed (timeout=${timedOut}, code=${code}, signal=${signal}).`);
	} finally {
		clearTimeout(timer);
		children.delete(child);
	}
}
async function powershell(script: string, extraEnv: Record<string, string> = {}): Promise<void> {
	await run(
		"pwsh.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64"),
		],
		60_000,
		extraEnv,
	);
}
async function waitFor(description: string, check: () => boolean, timeout = 60_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
		await new Promise((done) => setTimeout(done, 500));
	}
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function installerName(directory: string): string {
	const metadata: unknown = parse(readFileSync(join(directory, "latest.yml"), "utf8"));
	if (!record(metadata) || !Array.isArray(metadata.files) || metadata.files.length !== 1)
		throw new Error("Invalid NSIS update metadata.");
	const file: unknown = metadata.files[0];
	if (
		!record(file) ||
		typeof file.url !== "string" ||
		!/^Clawdi-[\d.]+-win32-x64-unsigned\.exe$/.test(file.url)
	)
		throw new Error("NSIS metadata must reference the unsigned installer artifact name.");
	const sha512 = createHash("sha512")
		.update(readFileSync(join(directory, file.url)))
		.digest("base64");
	assert.equal(file.sha512, sha512);
	assert.equal(metadata.path, file.url);
	assert.equal(metadata.sha512, sha512);
	assert.ok(
		existsSync(join(directory, `${file.url}.blockmap`)),
		"Missing NSIS differential blockmap.",
	);
	const config: unknown = parse(
		readFileSync(join(directory, "win-unpacked/resources/app-update.yml"), "utf8"),
	);
	assert.ok(
		record(config) && config.provider === "generic" && config.publisherName == null,
		"Unsigned NSIS app-update.yml must not pin a publisher.",
	);
	return file.url;
}

try {
	// Chromium/Electron use the Windows certificate store. Trust only this test
	// CA in the disposable account and remove that exact certificate in finally.
	// https://learn.microsoft.com/en-us/powershell/module/pki/import-certificate
	const openssl = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/usr/bin/openssl.exe");
	await run(openssl, [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		join(root, "ca.key"),
		"-out",
		join(root, "ca.crt"),
		"-days",
		"1",
		"-subj",
		"/CN=Clawdi Windows update e2e CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
	]);
	await run(openssl, [
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		join(root, "server.key"),
		"-out",
		join(root, "server.csr"),
		"-subj",
		"/CN=127.0.0.1",
	]);
	writeFileSync(
		join(root, "server.ext"),
		"subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
	);
	await run(openssl, [
		"x509",
		"-req",
		"-in",
		join(root, "server.csr"),
		"-CA",
		join(root, "ca.crt"),
		"-CAkey",
		join(root, "ca.key"),
		"-CAcreateserial",
		"-out",
		join(root, "server.crt"),
		"-days",
		"1",
		"-extfile",
		join(root, "server.ext"),
	]);
	await powershell(`
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new("$env:CLAWDI_DESKTOP_UPDATE_E2E_ROOT/ca.crt")
[System.IO.File]::WriteAllText("$env:CLAWDI_DESKTOP_UPDATE_E2E_ROOT/ca-thumbprint", $cert.Thumbprint)
Import-Certificate -FilePath "$env:CLAWDI_DESKTOP_UPDATE_E2E_ROOT/ca.crt" -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null
`);
	server = createServer({
		key: readFileSync(join(root, "server.key")),
		cert: readFileSync(join(root, "server.crt")),
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing local HTTPS address.");
	const feedUrl = `https://127.0.0.1:${address.port}/`;
	await run("bun", ["run", "build"]);
	renameSync(join(desktopRoot, "dist/main.js"), join(desktopRoot, "dist/desktop-main.js"));
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "fixtures/update-e2e-windows-main.ts")],
		target: "node",
		format: "esm",
		external: ["electron"],
		outdir: join(desktopRoot, "dist"),
		naming: "main.js",
	});
	if (!bundle.success)
		throw new Error(`Could not build Windows e2e entry: ${bundle.logs.join("\n")}`);
	const native = join(desktopRoot, "resources/native");
	mkdirSync(native, { recursive: true });
	await run("bun", [
		"build",
		join(import.meta.dir, "fixtures/update-e2e-windows-native.ts"),
		"--compile",
		`--outfile=${join(native, "clawdi.exe")}`,
	]);
	for (const file of [
		"skills/clawdi/SKILL.md",
		"skills/hosted-versions/1/clawdi/SKILL.md",
		"egress-addon/clawdi_egress_addon.py",
	]) {
		mkdirSync(resolve(native, file, ".."), { recursive: true });
		writeFileSync(join(native, file), "# Update e2e fixture\n");
	}
	for (const version of ["0.0.1", "0.0.2"]) {
		const configuration = readDesktopReleaseConfiguration(
			{
				CLAWDI_DESKTOP_VERSION: version,
				CLAWDI_DESKTOP_ARCH: "x64",
				CLAWDI_DESKTOP_UPDATE_FEED_URL: feedUrl,
			},
			"win32",
		);
		// The production unsigned-release config generates both latest.yml and
		// blockmaps; only the feed and build output are local. No update API stubs.
		await run(
			"bun",
			[
				...desktopReleaseBuilderArgs(configuration),
				`--config.directories.output=${join(root, version)}`,
				`--config.afterPack=${join(desktopRoot, "scripts/after-pack.mjs")}`,
				// Documented generic-provider option for this single-range HTTPS server.
				// https://www.electron.build/docs/publish/#genericserveroptions
				"--config.publish.useMultipleRangeRequest=false",
			],
			300_000,
		);
	}
	const previous = join(root, "0.0.1");
	const feed = join(root, "0.0.2");
	const previousName = installerName(previous);
	const nextName = installerName(feed);
	const sha512 = createHash("sha512")
		.update(readFileSync(join(feed, nextName)))
		.digest("base64");
	const requests: string[] = [];
	server.on("request", (request, response) => {
		const name = new URL(request.url ?? "/", feedUrl).pathname.slice(1);
		const directory = name === `${previousName}.blockmap` ? previous : feed;
		if (
			!["latest.yml", nextName, `${nextName}.blockmap`, `${previousName}.blockmap`].includes(name)
		) {
			response.writeHead(404).end();
			return;
		}
		requests.push(name);
		const file = join(directory, name);
		const size = statSync(file).size;
		const range = request.headers.range;
		const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
		const start = match ? Number(match[1]) : 0;
		const end = match?.[2] ? Number(match[2]) : size - 1;
		if ((range && !match) || start > end || end >= size) {
			response.writeHead(416).end();
			return;
		}
		response.writeHead(match ? 206 : 200, {
			"Content-Length": end - start + 1,
			"Accept-Ranges": "bytes",
			...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
		});
		createReadStream(file, { start, end })
			.on("error", (error) => response.destroy(error))
			.pipe(response);
	});
	// NSIS documents /S and the last /D argument for silent per-user install:
	// https://www.electron.build/docs/nsis#guid
	await run(join(previous, previousName), ["/S", `/D=${installed}`], 120_000);
	installedApp = true;
	const executable = join(installed, "Clawdi.exe");
	const cli = join(installed, "resources/native/clawdi.exe");
	taskCreated = true;
	await run(cli, ["daemon", "install"]);
	await waitFor(
		"initial task process",
		() => windowsTaskRunning() && existsSync(join(cliRoot, "service-starts.log")),
	);
	await run(executable, [], 180_000, {
		CLAWDI_DESKTOP_UPDATE_E2E_PHASE: "download",
		CLAWDI_DESKTOP_UPDATE_E2E_RESULT: join(root, "download.json"),
		CLAWDI_DESKTOP_UPDATE_E2E_SHA512: sha512,
	});
	const download: unknown = JSON.parse(readFileSync(join(root, "download.json"), "utf8"));
	assert.ok(record(download) && download.version === "0.0.1");
	assert.match(readFileSync(join(root, "cli.log"), "utf8"), /^daemon stop$/m);
	// Wait for the detached NSIS installer to finish replacing the ASAR. It
	// must not relaunch after install-on-quit (upstream BaseUpdater contract).
	const expected = createHash("sha512")
		.update(readFileSync(join(feed, "win-unpacked/resources/app.asar")))
		.digest("base64");
	await waitFor(
		"N+1 installation",
		() => {
			try {
				return (
					createHash("sha512")
						.update(readFileSync(join(installed, "resources/app.asar")))
						.digest("base64") === expected
				);
			} catch {
				return false;
			}
		},
		120_000,
	);
	await powershell(`
$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
  $installers = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:LOCALAPPDATA + '\\', [StringComparison]::OrdinalIgnoreCase)
  })
  if ($installers.Count -eq 0) { break }
  if ([DateTime]::UtcNow -gt $deadline) { throw 'Detached NSIS installer did not exit.' }
  Start-Sleep -Milliseconds 500
} while ($true)
if (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq "$env:CLAWDI_DESKTOP_UPDATE_E2E_ROOT\\installed\\Clawdi.exe" }) {
  throw 'Install-on-quit unexpectedly relaunched Desktop.'
}
`);
	assert.ok(windowsTaskInstalled(), "Upgrade must preserve the Sync task.");
	assert.equal(
		windowsTaskRunning(),
		false,
		"Install-on-quit leaves Sync stopped until next launch/logon.",
	);
	assert.equal(
		readFileSync(join(cliRoot, "service-starts.log"), "utf8").trim().split("\n").length,
		1,
	);
	await run(executable, [], 180_000, {
		CLAWDI_DESKTOP_UPDATE_E2E_PHASE: "verify",
		CLAWDI_DESKTOP_UPDATE_E2E_RESULT: join(root, "verified.json"),
	});
	const verified: unknown = JSON.parse(readFileSync(join(root, "verified.json"), "utf8"));
	assert.ok(record(verified) && verified.version === "0.0.2" && verified.serviceResumed === true);
	assert.match(readFileSync(join(root, "cli.log"), "utf8"), /^daemon restart$/m);
	assert.ok(windowsTaskRunning(), "Production N+1 startup must restart the real Windows task.");
	assert.ok(requests.includes("latest.yml") && requests.includes(nextName));
	assert.ok(
		requests.includes(`${nextName}.blockmap`),
		"NSIS updater must request the published blockmap.",
	);
	// The release workflow architecture-qualifies metadata; the feed restores
	// latest.yml. Check the unsigned path survives the actual isolation script.
	await run("bun", [
		"run",
		join(import.meta.dir, "isolate-update-metadata.ts"),
		feed,
		"win32",
		"x64",
		"stable",
	]);
	assert.ok(existsSync(join(feed, "latest-win32-x64.yml")));
	console.log(
		"Windows update e2e passed: trusted HTTPS, SHA-512, unsigned NSIS/blockmap, stop before install, N+1 launch and Task Scheduler resume.",
	);
} finally {
	// Kill only processes running from this test's private directory, including
	// detached updater installers; never use a name-wide taskkill.
	try {
		await powershell(`
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:CLAWDI_DESKTOP_UPDATE_E2E_ROOT + '\\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
`);
	} finally {
		for (const child of children) child.kill();
		try {
			if (taskCreated) uninstallWindowsTask(cliRoot);
			if (installedApp) await run(join(installed, "Uninstall Clawdi.exe"), ["/S"], 60_000);
		} finally {
			try {
				if (existsSync(join(root, "ca-thumbprint")))
					await powershell(`
$thumbprint = [System.IO.File]::ReadAllText("$env:CLAWDI_DESKTOP_UPDATE_E2E_ROOT/ca-thumbprint")
if (Test-Path "Cert:\\CurrentUser\\Root\\$thumbprint") { Remove-Item "Cert:\\CurrentUser\\Root\\$thumbprint" }
`);
			} finally {
				if (server) {
					server.closeAllConnections();
					await new Promise<void>((done) => server?.close(() => done()));
				}
				rmSync(root, { recursive: true, force: true });
			}
		}
	}
}
