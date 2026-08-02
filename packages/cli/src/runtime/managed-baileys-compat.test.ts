import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, SourceTextModule } from "node:vm";
import { gunzipSync } from "node:zlib";
import {
	MANAGED_BAILEYS_PATCH_REVISION,
	MANAGED_BAILEYS_STATIC_PATCH_TARGETS,
	type ManagedBaileysRuntime,
	managedBaileysCompatMutationTargets,
	managedBaileysCompatReceiptPath,
	reconcileManagedBaileysCompatibility,
} from "./managed-baileys-compat";

const repositoryRoot = join(import.meta.dir, "../../../..");
const fixtureRoot = join(import.meta.dir, "../../test-fixtures/managed-baileys");
const pristineBaileysRoot = join(
	repositoryRoot,
	"packages/whatsapp-baileys-sidecar/node_modules/baileys",
);
const temporaryRoots: string[] = [];

interface ArtifactFixture {
	runtime: ManagedBaileysRuntime;
	root: string;
	home: string;
	appRoot: string;
	artifactRoot: string;
	consumerPath: string;
	baileysRoot: string;
	installInventory: string;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each(["openclaw", "hermes"] as const)("managed Baileys %s compatibility", (runtime) => {
	it("is inert before a managed Link has produced a receipt", () => {
		const fixture = createArtifactFixture(runtime);

		const result = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
			paths: fixture,
		});

		expect(result.status).toBe("inert");
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
		for (const target of artifactTargets(fixture)) {
			expect(sha256File(target.path)).toBe(target.preimageSha256);
		}
	});

	it("applies only the audited preimages and records exact durable authority", () => {
		const fixture = createArtifactFixture(runtime);
		const result = reconcile(fixture);

		expect(result.status).toBe("applied");
		for (const target of artifactTargets(fixture)) {
			expect(sha256File(target.path)).toBe(target.postimageSha256);
		}
		const receiptPath = managedBaileysCompatReceiptPath(fixture);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
		expect(receipt).toMatchObject({
			schemaVersion: "clawdi.managedBaileysPatchReceipt.v2",
			patchRevision: MANAGED_BAILEYS_PATCH_REVISION,
			artifact: {
				runtime,
				artifactRoot: fixture.artifactRoot,
				consumer: expect.objectContaining({
					name: expect.any(String),
					version: expect.any(String),
				}),
				baileys: expect.objectContaining({ name: expect.any(String), version: "7.0.0-rc13" }),
				targets: artifactTargets(fixture).map((target) => ({
					relativePath: relative(fixture.artifactRoot, target.path),
					preimageSha256: target.preimageSha256,
					postimageSha256: target.postimageSha256,
				})),
			},
		});
		expect(JSON.stringify(receipt)).not.toContain("integrity");
		expect(receipt).not.toHaveProperty("appliedAt");
	});

	it("is a true no-op after the receipt and postimages converge", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const receiptPath = managedBaileysCompatReceiptPath(fixture);
		const beforeReceipt = readFileSync(receiptPath, "utf8");
		const beforeTargets = artifactTargets(fixture).map((target) => readFileSync(target.path));

		const result = reconcile(fixture);

		expect(result.status).toBe("already-patched");
		expect(readFileSync(receiptPath, "utf8")).toBe(beforeReceipt);
		artifactTargets(fixture).forEach((target, index) => {
			expect(readFileSync(target.path)).toEqual(beforeTargets[index]);
		});
	});

	it("recovers a pristine or mixed installer replacement and a missing receipt", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		restorePristineTarget(fixture, targets[0]);
		restorePristineTarget(fixture, targets.at(-1));

		expect(reconcile(fixture).status).toBe("applied");
		for (const target of targets) expect(sha256File(target.path)).toBe(target.postimageSha256);

		rmSync(managedBaileysCompatReceiptPath(fixture));
		expect(reconcile(fixture).status).toBe("receipt-recovered");
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(true);
	});

	it("rolls exact postimages back and refuses all mutation when one target drifted", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		writeFileSync(targets[0].path, `${readFileSync(targets[0].path, "utf8")}\n// drift\n`);
		const unchangedPostimage = readFileSync(targets[1].path);

		const refused = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
			paths: fixture,
		});

		expect(refused.status).toBe("rollback-refused");
		expect(readFileSync(targets[1].path)).toEqual(unchangedPostimage);
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(true);

		restorePristineTarget(fixture, targets[0]);
		reconcile(fixture);
		const rolledBack = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
			paths: fixture,
		});
		expect(rolledBack.status).toBe("rolled-back");
		for (const target of targets) expect(sha256File(target.path)).toBe(target.preimageSha256);
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
	});

	it("refuses rollback when a present artifact is missing one audited target", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		const missing = targets[0];
		if (!missing) throw new Error("missing rollback target fixture");
		rmSync(missing.path);
		const unchanged = targets.slice(1).map((target) => readFileSync(target.path));

		const result = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
			paths: fixture,
		});

		expect(result.status).toBe("rollback-refused");
		if (result.status !== "rollback-refused") throw new Error("expected rollback refusal");
		expect(result.errors.join("\n")).toContain(`artifact is missing ${missing.path}`);
		targets.slice(1).forEach((target, index) => {
			expect(readFileSync(target.path)).toEqual(unchanged[index]);
			expect(sha256File(target.path)).toBe(target.postimageSha256);
		});
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(true);
	});

	it("forgets the receipt when the entire audited artifact was uninstalled", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		rmSync(fixture.artifactRoot, { recursive: true });

		const result = reconcileManagedBaileysCompatibility({
			desiredRuntime: null,
			home: fixture.home,
			paths: fixture,
		});

		expect(result.status).toBe("rolled-back");
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
	});
});

it("refuses unknown versions and source drift before writing any receipt", () => {
	const versionFixture = createArtifactFixture("openclaw");
	writeJson(join(versionFixture.artifactRoot, "package.json"), {
		name: "@openclaw/whatsapp",
		version: "2026.7.2",
	});
	expect(() => reconcile(versionFixture)).toThrow("requires @openclaw/whatsapp@2026.7.1");
	expect(existsSync(managedBaileysCompatReceiptPath(versionFixture))).toBe(false);

	const baileysVersionFixture = createArtifactFixture("openclaw");
	writeJson(join(baileysVersionFixture.baileysRoot, "package.json"), {
		name: "baileys",
		version: "7.0.0-rc14",
	});
	expect(() => reconcile(baileysVersionFixture)).toThrow("requires baileys@7.0.0-rc13");
	expect(existsSync(managedBaileysCompatReceiptPath(baileysVersionFixture))).toBe(false);

	const hermesVersionFixture = createArtifactFixture("hermes");
	writeFileSync(
		join(hermesVersionFixture.appRoot, "pyproject.toml"),
		'[project]\nname = "hermes-agent"\nversion = "0.19.2"\n',
	);
	expect(() => reconcile(hermesVersionFixture)).toThrow("requires hermes-agent@0.19.1");
	expect(existsSync(managedBaileysCompatReceiptPath(hermesVersionFixture))).toBe(false);

	const hermesNameFixture = createArtifactFixture("hermes");
	writeFileSync(
		join(hermesNameFixture.appRoot, "pyproject.toml"),
		'[project]\nname = "different-agent"\nversion = "0.19.1"\n',
	);
	expect(() => reconcile(hermesNameFixture)).toThrow("requires hermes-agent@0.19.1");
	expect(existsSync(managedBaileysCompatReceiptPath(hermesNameFixture))).toBe(false);

	const driftFixture = createArtifactFixture("hermes");
	writeFileSync(driftFixture.consumerPath, `${readFileSync(driftFixture.consumerPath, "utf8")}\n`);
	expect(() => reconcile(driftFixture)).toThrow("refused drifted hermes artifacts");
	expect(existsSync(managedBaileysCompatReceiptPath(driftFixture))).toBe(false);
	for (const target of artifactTargets(driftFixture).slice(1)) {
		expect(sha256File(target.path)).toBe(target.preimageSha256);
	}
});

it("refuses symlinked package identity before reading or patching it", () => {
	const fixture = createArtifactFixture("openclaw");
	const packageJson = join(fixture.artifactRoot, "package.json");
	const redirected = join(fixture.root, "redirected-package.json");
	copyFileSync(packageJson, redirected);
	rmSync(packageJson);
	symlinkSync(redirected, packageJson);

	expect(() => reconcile(fixture)).toThrow("package identity must be a real file");
	expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
	for (const target of artifactTargets(fixture)) {
		expect(sha256File(target.path)).toBe(target.preimageSha256);
	}
});

it("snapshots the whole Hermes dependency tree whenever npm ci may replace it", () => {
	const fixture = createArtifactFixture("hermes");
	const nodeModules = join(fixture.artifactRoot, "node_modules");
	const exactTargets = managedBaileysCompatMutationTargets(fixture);

	expect(exactTargets).toContain(join(nodeModules, ".hermes-pkg-hash"));
	expect(exactTargets).not.toContain(nodeModules);

	rmSync(join(fixture.baileysRoot, "package.json"));
	expect(managedBaileysCompatMutationTargets(fixture)).toEqual([fixture.consumerPath, nodeModules]);
});

it("reinstalls a missing pristine Hermes Baileys tree before applying the patch", () => {
	const fixture = createArtifactFixture("hermes");
	const nodeModules = join(fixture.artifactRoot, "node_modules");
	const managedNpm = join(fixture.home, ".local", "bin", "npm");
	const pristineFiles = [
		["package.json", readFileSync(join(fixture.baileysRoot, "package.json"), "utf8")],
		...MANAGED_BAILEYS_STATIC_PATCH_TARGETS.baileys.map((target) => [
			target.relativePath,
			readFileSync(join(fixture.baileysRoot, target.relativePath), "utf8"),
		]),
	];
	mkdirSync(dirname(managedNpm), { recursive: true });
	writeFileSync(
		managedNpm,
		`#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const destination = join(process.cwd(), "node_modules", "@whiskeysockets", "baileys");
for (const [relativePath, content] of ${JSON.stringify(pristineFiles)}) {
  const path = join(destination, relativePath);
  mkdirSync(require("node:path").dirname(path), { recursive: true });
  writeFileSync(path, content);
}
writeFileSync(join(process.cwd(), "npm-invoked"), process.argv.slice(2).join(" "));
`,
	);
	chmodSync(managedNpm, 0o755);
	writeJson(join(fixture.artifactRoot, "package-lock.json"), { lockfileVersion: 3 });
	rmSync(nodeModules, { recursive: true });

	const result = reconcile(fixture);

	expect(result.status).toBe("applied");
	expect(readFileSync(join(fixture.artifactRoot, "npm-invoked"), "utf8")).toBe(
		"ci --ignore-scripts --silent",
	);
	for (const target of artifactTargets(fixture)) {
		expect(sha256File(target.path)).toBe(target.postimageSha256);
	}
	expect(existsSync(join(nodeModules, ".hermes-pkg-hash"))).toBe(true);
});

it("keeps upgrade headers out of fetch/media HTTP and preserves official Noise trust by default", () => {
	const fixture = createArtifactFixture("openclaw");
	reconcile(fixture);
	const websocket = readFileSync(
		join(fixture.baileysRoot, "lib/Socket/Client/websocket.js"),
		"utf8",
	);
	const socket = readFileSync(join(fixture.baileysRoot, "lib/Socket/socket.js"), "utf8");
	const noise = readFileSync(join(fixture.baileysRoot, "lib/Utils/noise-handler.js"), "utf8");
	const targetSources = artifactTargets(fixture).map((target) => ({
		path: target.path,
		source: readFileSync(target.path, "utf8"),
	}));

	expect(websocket).toContain("...this.config.webSocketHeaders");
	expect(websocket).toContain("new WebSocket(this.url");
	expect(socket).not.toContain("webSocketHeaders");
	expect(
		targetSources
			.filter(
				({ path, source }) =>
					path.startsWith(`${fixture.baileysRoot}/`) && source.includes("webSocketHeaders"),
			)
			.map(({ path }) => relative(fixture.baileysRoot, path)),
	).toEqual(["lib/Types/Socket.d.ts", "lib/Socket/Client/websocket.js"]);
	expect(noise).toContain("const trustedCert = authCert ?? WA_CERT_DETAILS;");
	expect(noise).toContain("Curve.verify(trustedCert.PUBLIC_KEY");
	expect(noise).toContain("issuerSerial !== trustedCert.SERIAL");
});

it("executes patched rc13 WebSocket and HTTP paths without leaking upgrade headers", async () => {
	const fixture = createArtifactFixture("openclaw");
	reconcile(fixture);
	const markerHeader = "x-clawdi-whatsapp-link-capability";
	const socketConfig = {
		connectTimeoutMs: 12_345,
		agent: { name: "upgrade-agent" },
		options: { headers: { "user-agent": "audited-client" } },
		webSocketHeaders: { [markerHeader]: "managed-link-selector" },
	};
	const upgrade = await executePatchedWebSocketClient(
		join(fixture.baileysRoot, "lib/Socket/Client/websocket.js"),
		socketConfig,
	);
	const upgradeOptions = Reflect.get(upgrade, "options");
	if (!upgradeOptions || typeof upgradeOptions !== "object") {
		throw new Error("patched WebSocket options were not captured");
	}
	const upgradeHeaders = Reflect.get(upgradeOptions, "headers");
	if (!upgradeHeaders || typeof upgradeHeaders !== "object") {
		throw new Error("patched WebSocket headers were not captured");
	}

	expect(Reflect.get(upgrade, "url")).toBe("wss://web.whatsapp.com/ws/chat");
	expect(Reflect.get(upgradeHeaders, "user-agent")).toBe("audited-client");
	expect(Reflect.get(upgradeHeaders, markerHeader)).toBe("managed-link-selector");

	const mediaModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Utils/messages-media.js")).href
	);
	const getHttpStream = Reflect.get(mediaModule, "getHttpStream");
	if (typeof getHttpStream !== "function") throw new Error("rc13 getHttpStream export is missing");
	let fetchInit: RequestInit | undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		mock(async (_input: string | URL | Request, init?: RequestInit) => {
			fetchInit = init;
			return new Response("media");
		}),
		{ preconnect: originalFetch.preconnect },
	);
	try {
		await Reflect.apply(getHttpStream, undefined, [
			new URL("https://mmg.whatsapp.net/media"),
			socketConfig.options,
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(fetchInit?.headers).toEqual({ "user-agent": "audited-client" });
	expect(JSON.stringify(fetchInit)).not.toContain(markerHeader);
});

it("executes patched rc13 Noise trust with the official default and a provided authority", async () => {
	const fixture = createArtifactFixture("hermes");
	reconcile(fixture);
	const defaultsModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Defaults/index.js")).href
	);
	const officialCert = Reflect.get(defaultsModule, "WA_CERT_DETAILS");
	if (!officialCert || typeof officialCert !== "object") {
		throw new Error("rc13 WA_CERT_DETAILS export is missing");
	}
	const harness = await loadPatchedNoiseHarness(
		join(fixture.baileysRoot, "lib/Utils/noise-handler.js"),
		officialCert,
	);
	const officialSerial = Reflect.get(officialCert, "SERIAL");
	const officialKey = Reflect.get(officialCert, "PUBLIC_KEY");
	if (typeof officialSerial !== "number" || !Buffer.isBuffer(officialKey)) {
		throw new Error("rc13 WA_CERT_DETAILS has an unexpected shape");
	}

	const defaultVerification = harness.verify(undefined, officialSerial);
	expect(defaultVerification.intermediateAuthorityKey).toEqual(officialKey);
	expect(() => harness.verify(undefined, officialSerial + 1)).toThrow("certification match failed");

	const customCert = {
		SERIAL: 73,
		ISSUER: "ClawdiManagedLink",
		PUBLIC_KEY: Buffer.alloc(32, 0x73),
	};
	const customVerification = harness.verify(customCert, customCert.SERIAL);
	expect(customVerification.intermediateAuthorityKey).toEqual(customCert.PUBLIC_KEY);
	expect(customVerification.intermediateAuthorityKey).not.toEqual(officialKey);
	expect(() => harness.verify(customCert, customCert.SERIAL + 1)).toThrow(
		"certification match failed",
	);
});

describe.each([
	"openclaw",
	"hermes",
] as const)("managed Baileys %s executable consumer config", (runtime) => {
	it("executes every initial or reconnect construction with freshly read managed options", async () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const authDir = join(fixture.root, "managed-auth");
		mkdirSync(authDir, { recursive: true });
		const constructSocket = await compilePatchedConsumerSocketConstructor(fixture, authDir);

		writeManagedSocketConfig(authDir, "selector-generation-1", 11);
		const initial = await constructSocket();
		writeManagedSocketConfig(authDir, "selector-generation-2", 22);
		const reconnect = await constructSocket();

		expect(managedCapability(initial)).toBe("selector-generation-1");
		expect(managedCapability(reconnect)).toBe("selector-generation-2");
		expect(managedAuthorityKey(initial)).toEqual(Buffer.alloc(32, 11));
		expect(managedAuthorityKey(reconnect)).toEqual(Buffer.alloc(32, 22));
		expect(initial).not.toHaveProperty("waWebSocketUrl");
		expect(reconnect).not.toHaveProperty("waWebSocketUrl");
		expect(reconnect).not.toEqual(initial);
	});
});

it("audits every stock constructor call site without treating source assertions as E2E", () => {
	const openclaw = createArtifactFixture("openclaw");
	const hermes = createArtifactFixture("hermes");
	reconcile(openclaw);
	reconcile(hermes);
	const openclawSource = readFileSync(openclaw.consumerPath, "utf8");
	const hermesSource = readFileSync(hermes.consumerPath, "utf8");

	expect(openclawSource.match(/managedSocketOptions\(authDir\)/g)).toHaveLength(2);
	expect(openclawSource).toContain('if (error?.code === "ENOENT") return null;');
	expect(openclawSource).toContain("const waWebSocketUrl = managedOptions ? void 0");
	expect(openclawSource).toContain("...managedOptions ?? {}");
	expect(openclawSource).not.toContain("/v1/channels/whatsapp/baileys");
	expect(openclawSource).not.toContain("CLAWDI_WA_WEBSOCKET_URL");
	expect(hermesSource.match(/managedSocketOptions\(\)/g)).toHaveLength(2);
	expect(hermesSource).toContain("if (error?.code === 'ENOENT') return {};");
	expect(hermesSource).toContain("setTimeout(startSocket, reason === 515 ? 1000 : 3000)");
	expect(hermesSource.indexOf("...managedSocketOptions()")).toBeGreaterThan(
		hermesSource.indexOf("async function startSocket()"),
	);
	expect(hermesSource.indexOf("...managedSocketOptions()")).toBeLessThan(
		hermesSource.indexOf("setTimeout(startSocket"),
	);
	expect(hermesSource).not.toContain("waWebSocketUrl");
	expect(hermesSource).not.toContain("/v1/channels/whatsapp/baileys");
});

function reconcile(fixture: ArtifactFixture) {
	return reconcileManagedBaileysCompatibility({
		desiredRuntime: fixture.runtime,
		home: fixture.home,
		appRoot: fixture.appRoot,
		paths: fixture,
	});
}

function createArtifactFixture(runtime: ManagedBaileysRuntime): ArtifactFixture {
	const root = mkdtempSync(join(tmpdir(), `clawdi-managed-baileys-${runtime}-`));
	temporaryRoots.push(root);
	const home = join(root, "home");
	const installInventory = join(root, "state", "install-inventory");
	const appRoot =
		runtime === "openclaw" ? join(home, ".openclaw") : join(home, ".hermes", "hermes-agent");
	const artifactRoot =
		runtime === "openclaw"
			? join(home, ".openclaw", "extensions", "whatsapp")
			: join(appRoot, "scripts", "whatsapp-bridge");
	const consumerPath = join(
		artifactRoot,
		runtime === "openclaw"
			? MANAGED_BAILEYS_STATIC_PATCH_TARGETS.openclaw.relativePath
			: "bridge.js",
	);
	const baileysRoot = join(
		artifactRoot,
		...(runtime === "openclaw"
			? ["node_modules", "baileys"]
			: ["node_modules", "@whiskeysockets", "baileys"]),
	);
	mkdirSync(dirname(consumerPath), { recursive: true });
	if (runtime === "openclaw") {
		copyFileSync(join(fixtureRoot, "openclaw-session-2026.7.1.fixture"), consumerPath);
		writeJson(join(artifactRoot, "package.json"), {
			name: "@openclaw/whatsapp",
			version: "2026.7.1",
		});
	} else {
		const compressed = Buffer.from(
			readFileSync(join(fixtureRoot, "hermes-bridge-0.19.1.js.gz.b64"), "utf8"),
			"base64",
		);
		writeFileSync(consumerPath, gunzipSync(compressed));
		writeFileSync(
			join(appRoot, "pyproject.toml"),
			'[project]\nname = "hermes-agent"\nversion = "0.19.1"\n',
		);
		writeJson(join(artifactRoot, "package.json"), {
			name: "hermes-whatsapp-bridge",
			version: "1.0.0",
		});
	}
	for (const target of MANAGED_BAILEYS_STATIC_PATCH_TARGETS.baileys) {
		const destination = join(baileysRoot, target.relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(pristineBaileysRoot, target.relativePath), destination);
	}
	writeJson(join(baileysRoot, "package.json"), {
		name: runtime === "openclaw" ? "baileys" : "@whiskeysockets/baileys",
		version: "7.0.0-rc13",
	});
	return {
		runtime,
		root,
		home,
		appRoot,
		artifactRoot,
		consumerPath,
		baileysRoot,
		installInventory,
	};
}

function artifactTargets(fixture: ArtifactFixture) {
	const consumer =
		fixture.runtime === "openclaw"
			? MANAGED_BAILEYS_STATIC_PATCH_TARGETS.openclaw
			: MANAGED_BAILEYS_STATIC_PATCH_TARGETS.hermes;
	return [
		{ ...consumer, path: fixture.consumerPath },
		...MANAGED_BAILEYS_STATIC_PATCH_TARGETS.baileys.map((target) => ({
			...target,
			path: join(fixture.baileysRoot, target.relativePath),
		})),
	];
}

function restorePristineTarget(
	fixture: ArtifactFixture,
	target: ReturnType<typeof artifactTargets>[number] | undefined,
): void {
	if (!target) throw new Error("missing fixture target");
	if (target.path === fixture.consumerPath) {
		if (fixture.runtime === "openclaw") {
			copyFileSync(join(fixtureRoot, "openclaw-session-2026.7.1.fixture"), target.path);
		} else {
			const compressed = Buffer.from(
				readFileSync(join(fixtureRoot, "hermes-bridge-0.19.1.js.gz.b64"), "utf8"),
				"base64",
			);
			writeFileSync(target.path, gunzipSync(compressed));
		}
		return;
	}
	copyFileSync(join(pristineBaileysRoot, relative(fixture.baileysRoot, target.path)), target.path);
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function executePatchedWebSocketClient(
	path: string,
	config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const capture: Record<string, unknown> = {};
	const context = createContext({ capture });
	const module = new SourceTextModule(readFileSync(path, "utf8"), {
		context,
		identifier: path,
	});
	const stubs = new Map([
		[
			"ws",
			new SourceTextModule(
				`export default class WebSocket {
					static OPEN = 1; static CLOSED = 3; static CLOSING = 2; static CONNECTING = 0;
					constructor(url, options) { capture.url = String(url); capture.options = options; }
					setMaxListeners() {} on() {} once() {} close() {} send() {}
				}`,
				{ context, identifier: "ws" },
			),
		],
		[
			"../../Defaults/index.js",
			new SourceTextModule(`export const DEFAULT_ORIGIN = "https://web.whatsapp.com";`, {
				context,
				identifier: "defaults",
			}),
		],
		[
			"./types.js",
			new SourceTextModule(
				`export class AbstractSocketClient {
					constructor(url, config) { this.url = url; this.config = config; }
					setMaxListeners() {} emit() {}
				}`,
				{ context, identifier: "socket-types" },
			),
		],
	]);
	await module.link((specifier) => {
		const dependency = stubs.get(specifier);
		if (!dependency) throw new Error(`unexpected WebSocket module dependency: ${specifier}`);
		return dependency;
	});
	await module.evaluate();
	const Client = Reflect.get(module.namespace, "WebSocketClient");
	if (typeof Client !== "function") throw new Error("patched WebSocketClient export is missing");
	const client = Reflect.construct(Client, [new URL("wss://web.whatsapp.com/ws/chat"), config]);
	if (!client || typeof client !== "object") throw new Error("WebSocketClient construction failed");
	const connect = Reflect.get(client, "connect");
	if (typeof connect !== "function") throw new Error("patched WebSocketClient.connect is missing");
	Reflect.apply(connect, client, []);
	return capture;
}

async function loadPatchedNoiseHarness(path: string, officialCert: object) {
	const capture: { issuerSerial: number; verifiedKeys: Buffer[] } = {
		issuerSerial: 0,
		verifiedKeys: [],
	};
	const context = createContext({ Buffer, capture, officialCert });
	const module = new SourceTextModule(readFileSync(path, "utf8"), {
		context,
		identifier: path,
	});
	const stubs = new Map([
		[
			"@hapi/boom",
			new SourceTextModule(
				`export class Boom extends Error { constructor(message) { super(message); } }`,
				{ context, identifier: "boom" },
			),
		],
		[
			"../../WAProto/index.js",
			new SourceTextModule(
				`export const proto = { CertChain: {
					decode() { return {
						intermediate: { details: Buffer.from("intermediate"), signature: Buffer.from("sig") },
						leaf: { details: Buffer.from("leaf"), signature: Buffer.from("sig") }
					}; },
					NoiseCertificate: { Details: { decode() { return {
						issuerSerial: capture.issuerSerial, key: Buffer.alloc(32, 1)
					}; } } }
				} };`,
				{ context, identifier: "wa-proto" },
			),
		],
		[
			"../Defaults/index.js",
			new SourceTextModule(
				`export const NOISE_MODE = "Noise_XX_25519_AESGCM_SHA256";
				export const WA_CERT_DETAILS = officialCert;`,
				{ context, identifier: "noise-defaults" },
			),
		],
		[
			"../WABinary/index.js",
			new SourceTextModule(`export async function decodeBinaryNode(value) { return value; }`, {
				context,
				identifier: "wa-binary",
			}),
		],
		[
			"./crypto.js",
			new SourceTextModule(
				`export const aesDecryptGCM = value => value;
				export const aesEncryptGCM = value => Buffer.from(value);
				export const Curve = {
					sharedKey() { return Buffer.alloc(32, 2); },
					verify(key) { capture.verifiedKeys.push(Buffer.from(key)); return true; }
				};
				export const hkdf = (_value, length) => Buffer.alloc(length, 3);
				export const sha256 = () => Buffer.alloc(32, 4);`,
				{ context, identifier: "noise-crypto" },
			),
		],
	]);
	await module.link((specifier) => {
		const dependency = stubs.get(specifier);
		if (!dependency) throw new Error(`unexpected Noise module dependency: ${specifier}`);
		return dependency;
	});
	await module.evaluate();
	const makeNoiseHandler = Reflect.get(module.namespace, "makeNoiseHandler");
	if (typeof makeNoiseHandler !== "function") {
		throw new Error("patched makeNoiseHandler export is missing");
	}
	return {
		verify(authCert: object | undefined, issuerSerial: number) {
			capture.issuerSerial = issuerSerial;
			capture.verifiedKeys = [];
			const logger = {
				level: "silent",
				child() {
					return this;
				},
				trace() {},
			};
			const handler = Reflect.apply(makeNoiseHandler, undefined, [
				{
					keyPair: { private: Buffer.alloc(32, 5), public: Buffer.alloc(32, 6) },
					NOISE_HEADER: Buffer.from("WA"),
					logger,
					...(authCert ? { authCert } : {}),
				},
			]);
			if (!handler || typeof handler !== "object") throw new Error("Noise handler is invalid");
			const processHandshake = Reflect.get(handler, "processHandshake");
			if (typeof processHandshake !== "function") {
				throw new Error("patched processHandshake is missing");
			}
			Reflect.apply(processHandshake, handler, [
				{
					serverHello: {
						ephemeral: Buffer.alloc(32, 7),
						static: Buffer.alloc(32, 8),
						payload: Buffer.alloc(32, 9),
					},
				},
				{ private: Buffer.alloc(32, 10), public: Buffer.alloc(32, 11) },
			]);
			const intermediateAuthorityKey = capture.verifiedKeys[1];
			if (!intermediateAuthorityKey) throw new Error("intermediate authority was not verified");
			return { intermediateAuthorityKey };
		},
	};
}

async function compilePatchedConsumerSocketConstructor(
	fixture: ArtifactFixture,
	authDir: string,
): Promise<() => Promise<object>> {
	const source = readFileSync(fixture.consumerPath, "utf8");
	const start = source.indexOf("function managedSocketOptions");
	const endMarker =
		fixture.runtime === "openclaw"
			? "\nasync function rejectUnsafeWebCredsPath"
			: "\n// Cache directories";
	const end = source.indexOf(endMarker, start);
	if (start < 0 || end < 0) throw new Error("patched managedSocketOptions source is missing");
	const functionSource = source.slice(start, end);
	const genericsModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Utils/generics.js")).href
	);
	const BufferJSON = Reflect.get(genericsModule, "BufferJSON");
	const socketOptions: object[] = [];
	const makeWASocket = (options: object) => {
		socketOptions.push(options);
		return { ev: { on() {} } };
	};
	const logger = { info() {}, warn() {}, error() {} };
	if (fixture.runtime === "hermes") {
		const startSocketStart = source.indexOf("async function startSocket()");
		const startSocketEnd = source.indexOf("\n// HTTP server", startSocketStart);
		if (startSocketStart < 0 || startSocketEnd < 0) {
			throw new Error("patched Hermes startSocket source is missing");
		}
		const startSocketSource = source.slice(startSocketStart, startSocketEnd);
		const factory = Function(
			"readFileSync",
			"path",
			"BufferJSON",
			"SESSION_DIR",
			"CLAWDI_MANAGED_SOCKET_CONFIG",
			"CLAWDI_LINK_CAPABILITY_HEADER",
			"useMultiFileAuthState",
			"fetchLatestBaileysVersion",
			"makeWASocket",
			"logger",
			`"use strict";\n${functionSource}\nlet sock = null;\nlet connectionState = "disconnected";\n${startSocketSource}\nreturn startSocket;`,
		);
		const startSocket = Reflect.apply(factory, undefined, [
			readFileSync,
			{ join },
			BufferJSON,
			authDir,
			".clawdi-managed-whatsapp-socket.json",
			"x-clawdi-whatsapp-link-capability",
			async () => ({ state: {}, saveCreds() {} }),
			async () => ({ version: [2, 3_000, 1] }),
			makeWASocket,
			logger,
		]);
		if (typeof startSocket !== "function") {
			throw new Error("patched Hermes startSocket did not compile");
		}
		return async () =>
			captureConstructedSocketOptions(socketOptions, async () => {
				await Reflect.apply(startSocket, undefined, []);
			});
	}

	const createSocketStart = source.indexOf("async function createWaSocket(");
	const createSocketEnd = source.indexOf(
		"\nasync function resolveEnvProxyAgent",
		createSocketStart,
	);
	if (createSocketStart < 0 || createSocketEnd < 0) {
		throw new Error("patched OpenClaw createWaSocket source is missing");
	}
	const createSocketSource = source.slice(createSocketStart, createSocketEnd);
	const factory = Function(
		"readFileSync",
		"join",
		"BufferJSON",
		"CLAWDI_MANAGED_SOCKET_CONFIG",
		"CLAWDI_LINK_CAPABILITY_HEADER",
		"toPinoLikeLogger",
		"getChildLogger",
		"resolveUserPath",
		"resolveDefaultWebAuthDir",
		"rejectUnsafeWebCredsPath",
		"ensureDir",
		"waitForCredsSaveQueueWithTimeout",
		"restoreCredsFromBackupIfNeeded",
		"useMultiFileAuthState",
		"writeCredsJsonAtomically",
		"fetchLatestBaileysVersion",
		"resolveEnvProxyAgent",
		"resolveEnvFetchDispatcher",
		"DEFAULT_WHATSAPP_SOCKET_TIMING",
		"makeWASocket",
		"makeCacheableSignalKeyStore",
		"VERSION",
		`"use strict";\n${functionSource}\n${createSocketSource}\nreturn createWaSocket;`,
	);
	const createSocket = Reflect.apply(factory, undefined, [
		readFileSync,
		join,
		BufferJSON,
		".clawdi-managed-whatsapp-socket.json",
		"x-clawdi-whatsapp-link-capability",
		() => logger,
		() => logger,
		(value: string) => value,
		() => authDir,
		async () => {},
		async () => {},
		async () => "flushed",
		async () => {},
		async () => ({ state: { creds: {}, keys: {} } }),
		async () => {},
		async () => ({ version: [2, 3_000, 1] }),
		async () => undefined,
		async () => undefined,
		{ keepAliveIntervalMs: 1, connectTimeoutMs: 2, defaultQueryTimeoutMs: 3 },
		makeWASocket,
		() => ({}),
		"test",
	]);
	if (typeof createSocket !== "function") {
		throw new Error("patched OpenClaw createWaSocket did not compile");
	}
	return async () =>
		captureConstructedSocketOptions(socketOptions, async () => {
			await Reflect.apply(createSocket, undefined, [false, false, { authDir }]);
		});
}

async function captureConstructedSocketOptions(
	options: object[],
	construct: () => Promise<void>,
): Promise<object> {
	const before = options.length;
	await construct();
	const captured = options[before];
	if (!captured || options.length !== before + 1) {
		throw new Error("consumer did not construct exactly one Baileys socket");
	}
	return captured;
}

function writeManagedSocketConfig(authDir: string, capability: string, keyByte: number): void {
	writeJson(join(authDir, ".clawdi-managed-whatsapp-socket.json"), {
		schemaVersion: "clawdi.managedWhatsAppSocket.v1",
		capability,
		authCert: {
			SERIAL: keyByte,
			ISSUER: "ClawdiManagedLink",
			PUBLIC_KEY: { type: "Buffer", data: Buffer.alloc(32, keyByte).toString("base64") },
		},
	});
}

function managedCapability(options: object): unknown {
	const headers = Reflect.get(options, "webSocketHeaders");
	return Reflect.get(headers, "x-clawdi-whatsapp-link-capability");
}

function managedAuthorityKey(options: object): unknown {
	const authCert = Reflect.get(options, "authCert");
	return Reflect.get(authCert, "PUBLIC_KEY");
}
