import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	cpSync,
	createReadStream,
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

if (process.platform !== "linux" || process.arch !== "x64")
	throw new Error("Update e2e requires native Linux x64.");
const desktopRoot = resolve(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "clawdi-desktop-update-"));
const home = join(root, "home");
mkdirSync(home);
const children = new Set<ChildProcess>();
let server: ReturnType<typeof createServer> | undefined;
const env = {
	...process.env,
	HOME: home,
	XDG_CONFIG_HOME: join(home, ".config"),
	XDG_CACHE_HOME: join(home, ".cache"),
	CLAWDI_HOME: join(home, ".clawdi"),
	ELECTRON_BUILDER_CACHE: join(root, "builder-cache"),
	ELECTRON_CACHE: join(root, "electron-cache"),
	APPIMAGE_EXTRACT_AND_RUN: "1",
	CLAWDI_DESKTOP_UPDATE_E2E_CLI_LOG: join(root, "cli.log"),
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
		detached: true,
	});
	children.add(child);
	const timer = setTimeout(() => {
		if (child.pid) process.kill(-child.pid, "SIGKILL");
	}, timeout);
	try {
		const [code, signal] = await once(child, "exit");
		if (code !== 0) throw new Error(`${command} failed (code=${code}, signal=${signal}).`);
	} finally {
		clearTimeout(timer);
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH")
					console.error("Could not stop the e2e process group", error);
			}
		}
		children.delete(child);
	}
}

try {
	// Trust a task-local CA in Chromium's NSS database. Never bypass TLS checks:
	// https://chromium.googlesource.com/chromium/src/+/main/docs/linux/cert_management.md
	await run("openssl", [
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
		"/CN=Clawdi update e2e CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
	]);
	await run("openssl", [
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
	await run("openssl", [
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
	const nss = join(home, ".pki/nssdb");
	mkdirSync(nss, { recursive: true });
	await run("certutil", ["-N", "-d", `sql:${nss}`, "--empty-password"]);
	await run("certutil", [
		"-A",
		"-d",
		`sql:${nss}`,
		"-n",
		"Clawdi update e2e CA",
		"-t",
		"C,,",
		"-i",
		join(root, "ca.crt"),
	]);
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
		entrypoints: [join(import.meta.dir, "fixtures/update-e2e-main.ts")],
		target: "node",
		format: "esm",
		external: ["electron"],
		outdir: join(desktopRoot, "dist"),
		naming: "main.js",
	});
	if (!bundle.success) throw new Error(`Could not build e2e entry: ${bundle.logs.join("\n")}`);
	const native = join(desktopRoot, "resources/native");
	mkdirSync(native, { recursive: true });
	cpSync(join(import.meta.dir, "fixtures/update-e2e-native.sh"), join(native, "clawdi"));
	for (const file of [
		"skills/clawdi/SKILL.md",
		"skills/hosted-versions/1/clawdi/SKILL.md",
		"egress-addon/clawdi_egress_addon.py",
	]) {
		mkdirSync(resolve(native, file, ".."), { recursive: true });
		writeFileSync(join(native, file), "# Update e2e fixture\n");
	}
	await run("chmod", ["+x", join(native, "clawdi")]);
	for (const version of ["0.0.1", "0.0.2"]) {
		// Official builder CLI; only AppImages are needed, no release publication.
		await run(
			"bun",
			[
				"run",
				"electron-builder",
				"--linux",
				"AppImage",
				"--x64",
				"--publish",
				"never",
				`--config.directories.output=${join(root, version)}`,
				`--config.afterPack=${join(desktopRoot, "scripts/after-pack.mjs")}`,
				`--config.extraMetadata.version=${version}`,
				"--config.extraMetadata.clawdiUpdateChannel=stable",
				`--config.linux.artifactName=Clawdi-\${version}-linux-\${arch}.\${ext}`,
				"--config.publish.provider=generic",
				"--config.publish.channel=latest",
				// The local HTTPS server supports single byte ranges. Declare that
				// through GenericServerOptions, rather than replacing the downloader:
				// https://www.electron.build/docs/features/auto-update/
				"--config.publish.useMultipleRangeRequest=false",
				`--config.publish.url=${feedUrl}`,
			],
			240_000,
		);
	}
	const feed = join(root, "0.0.2");
	const metadata = parse(readFileSync(join(feed, "latest-linux.yml"), "utf8"));
	assert.equal(metadata.version, "0.0.2");
	const imageName: unknown = metadata.files[0].url;
	if (typeof imageName !== "string" || !/^[\w.+-]+\.AppImage$/.test(imageName))
		throw new Error("Invalid AppImage artifact name.");
	const sha512 = createHash("sha512")
		.update(readFileSync(join(feed, imageName)))
		.digest("base64");
	assert.equal(metadata.files[0].sha512, sha512);
	const requests: string[] = [];
	server.on("request", (request, response) => {
		const name = new URL(request.url ?? "/", feedUrl).pathname.slice(1);
		if (!["latest-linux.yml", imageName].includes(name)) {
			response.writeHead(404).end();
			return;
		}
		requests.push(name);
		const file = join(feed, name);
		const size = statSync(file).size;
		const match = request.headers.range ? /^bytes=(\d+)-(\d*)$/.exec(request.headers.range) : null;
		const start = match ? Number(match[1]) : 0;
		const end = match?.[2] ? Number(match[2]) : size - 1;
		if ((request.headers.range && !match) || start > end || end >= size) {
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
	const installed = join(root, "Clawdi.AppImage");
	// Reuse unpacked N for the package-manager path; no DEB/RPM builds.
	const noticeHome = join(root, "notice-home");
	mkdirSync(join(noticeHome, ".pki"), { recursive: true });
	cpSync(nss, join(noticeHome, ".pki/nssdb"), { recursive: true });
	await run(
		join(root, "0.0.1/linux-unpacked/clawdi-desktop"),
		["--no-sandbox", "--use-mock-keychain"],
		120_000,
		{
			HOME: noticeHome,
			XDG_CONFIG_HOME: join(noticeHome, ".config"),
			XDG_CACHE_HOME: join(noticeHome, ".cache"),
			CLAWDI_HOME: join(noticeHome, ".clawdi"),
			CLAWDI_DESKTOP_UPDATE_E2E_CLI_LOG: join(root, "notice-cli.log"),
			CLAWDI_DESKTOP_UPDATE_E2E_PHASE: "notice",
			CLAWDI_DESKTOP_UPDATE_E2E_RESULT: join(root, "notice.json"),
		},
	);
	assert.equal(JSON.parse(readFileSync(join(root, "notice.json"), "utf8")).notice, true);
	assert.ok(
		!requests.includes(imageName),
		"A package-manager installation must not download the image.",
	);
	assert.doesNotMatch(readFileSync(join(root, "notice-cli.log"), "utf8"), /^daemon stop$/m);
	const previous = parse(readFileSync(join(root, "0.0.1/latest-linux.yml"), "utf8"));
	const previousName: unknown = previous.files[0].url;
	if (typeof previousName !== "string" || !/^[\w.+-]+\.AppImage$/.test(previousName))
		throw new Error("Invalid previous AppImage artifact name.");
	cpSync(join(root, "0.0.1", previousName), installed);
	await run(installed, ["--no-sandbox", "--use-mock-keychain"], 120_000, {
		CLAWDI_DESKTOP_UPDATE_E2E_PHASE: "download",
		CLAWDI_DESKTOP_UPDATE_E2E_RESULT: join(root, "download.json"),
		CLAWDI_DESKTOP_UPDATE_E2E_SHA512: sha512,
	});
	assert.equal(JSON.parse(readFileSync(join(root, "download.json"), "utf8")).version, "0.0.1");
	assert.doesNotMatch(readFileSync(join(root, "cli.log"), "utf8"), /^daemon stop$/m);
	assert.equal(
		createHash("sha512").update(readFileSync(installed)).digest("base64"),
		sha512,
		"The installed image must equal the pinned N+1 asset.",
	);
	await run(installed, ["--no-sandbox", "--use-mock-keychain"], 30_000, {
		CLAWDI_DESKTOP_UPDATE_E2E_PHASE: "verify",
		CLAWDI_DESKTOP_UPDATE_E2E_RESULT: join(root, "verified.json"),
	});
	assert.equal(JSON.parse(readFileSync(join(root, "verified.json"), "utf8")).version, "0.0.2");
	assert.ok(requests.includes("latest-linux.yml") && requests.includes(imageName));
	console.log(
		"Desktop update e2e passed: HTTPS feed, SHA-512 download, no service stop, install on quit, N+1 launch.",
	);
} finally {
	for (const child of children)
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}
	if (server) {
		const runningServer = server;
		runningServer.closeAllConnections();
		await new Promise<void>((resolveClose) => runningServer.close(() => resolveClose()));
	}
	rmSync(root, { recursive: true, force: true });
}
