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
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, SourceTextModule } from "node:vm";
import {
	MANAGED_BAILEYS_PATCH_REVISION,
	MANAGED_BAILEYS_STATIC_PATCH_TARGETS,
	type ManagedBaileysRuntime,
	managedBaileysCompatMutationTargets,
	managedBaileysCompatReceiptPath,
	reconcileManagedBaileysCompatibility,
} from "./managed-baileys-compat";

const repositoryRoot = join(import.meta.dir, "../../../..");
const pristineBaileysRoot = join(
	repositoryRoot,
	"packages/whatsapp-baileys-sidecar/node_modules/baileys",
);
const rc13DefaultsModule = await import(
	pathToFileURL(join(pristineBaileysRoot, "lib/Defaults/index.js")).href
);
const rc13DefaultConnectionConfig = Reflect.get(rc13DefaultsModule, "DEFAULT_CONNECTION_CONFIG");
if (!rc13DefaultConnectionConfig || typeof rc13DefaultConnectionConfig !== "object") {
	throw new Error("rc13 DEFAULT_CONNECTION_CONFIG export is missing");
}
const rc13DefaultWebSocketUrl = Reflect.get(rc13DefaultConnectionConfig, "waWebSocketUrl");
if (typeof rc13DefaultWebSocketUrl !== "string") {
	throw new Error("rc13 default WhatsApp WebSocket URL is missing");
}
const temporaryRoots: string[] = [];

interface ArtifactFixture {
	runtime: ManagedBaileysRuntime;
	root: string;
	home: string;
	appRoot: string;
	baileysRoot: string;
	installInventory: string;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("defines exactly the three audited Baileys targets and no consumer target", () => {
	expect(MANAGED_BAILEYS_STATIC_PATCH_TARGETS.map((target) => target.relativePath)).toEqual([
		"lib/Socket/socket.js",
		"lib/Utils/noise-handler.js",
		"lib/Utils/noise-handler.d.ts",
	]);
	const socketPatch = MANAGED_BAILEYS_STATIC_PATCH_TARGETS[0];
	expect(socketPatch?.replacements.map((replacement) => replacement.after).join("\n")).toContain(
		"DEFAULT_CONNECTION_CONFIG.waWebSocketUrl",
	);
	expect(
		socketPatch?.replacements.map((replacement) => replacement.after).join("\n"),
	).not.toContain("wss://web.whatsapp.com/ws/chat");
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
		assertTargetState(fixture, "preimage");
	});

	it("applies only audited preimages and records the observed compatible identity", () => {
		const fixture = createArtifactFixture(runtime);
		const result = reconcile(fixture);

		expect(result.status).toBe("applied");
		assertTargetState(fixture, "postimage");
		const receipt = readReceipt(fixture);
		expect(receipt).toMatchObject({
			schemaVersion: "clawdi.managedBaileysPatchReceipt.v3",
			patchRevision: MANAGED_BAILEYS_PATCH_REVISION,
			artifact: {
				runtime,
				artifactRoot: fixture.baileysRoot,
				baileys: {
					name: runtime === "openclaw" ? "baileys" : "@whiskeysockets/baileys",
					observedVersion: "7.0.0-rc13",
					compatibleMajor: 7,
				},
				targets: artifactTargets(fixture).map(({ target }) => ({
					relativePath: target.relativePath,
					preimageSha256: target.preimageSha256,
					postimageSha256: target.postimageSha256,
				})),
			},
		});
		expect(JSON.stringify(receipt)).not.toContain("integrity");
		expect(receipt).not.toHaveProperty("appliedAt");
	});

	it("is a no-op after receipt and postimages converge", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const receiptPath = managedBaileysCompatReceiptPath(fixture);
		const beforeReceipt = readFileSync(receiptPath, "utf8");
		const beforeTargets = artifactTargets(fixture).map(({ path }) => readFileSync(path));

		expect(reconcile(fixture).status).toBe("already-patched");
		expect(readFileSync(receiptPath, "utf8")).toBe(beforeReceipt);
		artifactTargets(fixture).forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(beforeTargets[index]);
		});
	});

	it("recovers recognized pristine, mixed, and missing-receipt states", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		restorePristineTarget(targets[0]);
		restorePristineTarget(targets.at(-1));

		expect(reconcile(fixture).status).toBe("applied");
		assertTargetState(fixture, "postimage");

		rmSync(managedBaileysCompatReceiptPath(fixture));
		expect(reconcile(fixture).status).toBe("receipt-recovered");
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(true);
	});

	it("preflights all targets before rollback and refuses drift with zero other mutation", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		const drifted = targets[0];
		if (!drifted) throw new Error("missing drift target");
		writeFileSync(drifted.path, `${readFileSync(drifted.path, "utf8")}\n// drift\n`);
		const unchanged = targets.slice(1).map(({ path }) => readFileSync(path));

		const refused = rollback(fixture);

		expect(refused.status).toBe("rollback-refused");
		targets.slice(1).forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(unchanged[index]);
		});
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(true);
	});

	it("refuses rollback when a present package is missing one audited target", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const targets = artifactTargets(fixture);
		const missing = targets[0];
		if (!missing) throw new Error("missing rollback target fixture");
		rmSync(missing.path);
		const unchanged = targets.slice(1).map(({ path }) => readFileSync(path));

		const result = rollback(fixture);

		expect(result.status).toBe("rollback-refused");
		if (result.status !== "rollback-refused") throw new Error("expected rollback refusal");
		expect(result.errors.join("\n")).toContain(`artifact is missing ${missing.path}`);
		targets.slice(1).forEach(({ path }, index) => {
			expect(readFileSync(path)).toEqual(unchanged[index]);
		});
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(true);
	});

	it("forgets the receipt only when the entire audited package root is uninstalled", () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		rmSync(fixture.baileysRoot, { recursive: true });

		expect(rollback(fixture).status).toBe("rolled-back");
		expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
	});
});

it.each([
	["openclaw", "7.1.2"],
	["hermes", "7.0.0-rc14"],
] as const)("accepts %s alias at alternate exact-hash %s", (runtime, version) => {
	const fixture = createArtifactFixture(runtime, version);

	expect(reconcile(fixture).status).toBe("applied");
	expect(readReceipt(fixture).artifact.baileys.observedVersion).toBe(version);
	assertTargetState(fixture, "postimage");
});

it("rejects alternate 7.x target drift with zero mutation", () => {
	const fixture = createArtifactFixture("openclaw", "7.9.0-beta.1");
	const targets = artifactTargets(fixture);
	const drifted = targets[1];
	if (!drifted) throw new Error("missing drift target");
	writeFileSync(drifted.path, `${readFileSync(drifted.path, "utf8")}\n`);
	const unchanged = targets.map(({ path }) => readFileSync(path));

	expect(() => reconcile(fixture)).toThrow("refused drifted openclaw artifacts");
	targets.forEach(({ path }, index) => {
		expect(readFileSync(path)).toEqual(unchanged[index]);
	});
	expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
});

it.each(["8.0.0", "6.9.9"])("rejects incompatible Baileys major %s", (version) => {
	const fixture = createArtifactFixture("openclaw", version);
	expect(() => reconcile(fixture)).toThrow("requires valid Baileys SemVer major 7");
	assertTargetState(fixture, "preimage");
	expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
});

it.each([
	"7.*",
	"7.0",
	"07.0.0",
	"7.0.0-rc.01",
	"v7.0.0",
	"not-semver",
])("rejects malformed Baileys version %s", (version) => {
	const fixture = createArtifactFixture("hermes", version);
	expect(() => reconcile(fixture)).toThrow("requires valid Baileys SemVer major 7");
	assertTargetState(fixture, "preimage");
	expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
});

it("updates a compatible 7.x receipt transition and still rolls back safely", () => {
	const fixture = createArtifactFixture("openclaw");
	reconcile(fixture);
	writeBaileysIdentity(fixture, "7.4.1-rc.2");

	expect(reconcile(fixture).status).toBe("receipt-recovered");
	expect(readReceipt(fixture).artifact.baileys.observedVersion).toBe("7.4.1-rc.2");
	expect(rollback(fixture).status).toBe("rolled-back");
	assertTargetState(fixture, "preimage");
});

it("refuses an unknown receipt revision without touching pristine targets", () => {
	const fixture = createArtifactFixture("openclaw");
	writeJson(managedBaileysCompatReceiptPath(fixture), {
		schemaVersion: "clawdi.managedBaileysPatchReceipt.v999",
		patchRevision: "unknown",
	});

	expect(() => reconcile(fixture)).toThrow("receipt is invalid");
	assertTargetState(fixture, "preimage");
});

it("rejects the wrong alias package name and symlinked package identity", () => {
	const wrongName = createArtifactFixture("openclaw");
	writeJson(join(wrongName.baileysRoot, "package.json"), {
		name: "@whiskeysockets/baileys",
		version: "7.0.0-rc13",
	});
	expect(() => reconcile(wrongName)).toThrow("requires package baileys");
	assertTargetState(wrongName, "preimage");

	const symlinked = createArtifactFixture("hermes");
	const packagePath = join(symlinked.baileysRoot, "package.json");
	const redirected = join(symlinked.root, "redirected-package.json");
	copyFileSync(packagePath, redirected);
	rmSync(packagePath);
	symlinkSync(redirected, packagePath);
	expect(() => reconcile(symlinked)).toThrow("target must be a real file");
	assertTargetState(symlinked, "preimage");
});

it("refuses a symlinked patch target before mutating any audited file", () => {
	const fixture = createArtifactFixture("openclaw");
	const targets = artifactTargets(fixture);
	const target = targets[0];
	if (!target) throw new Error("missing symlink target fixture");
	const redirected = join(fixture.root, "redirected-target.js");
	copyFileSync(target.path, redirected);
	rmSync(target.path);
	symlinkSync(redirected, target.path);
	const unchanged = targets.slice(1).map(({ path }) => readFileSync(path));

	expect(() => reconcile(fixture)).toThrow("target must be a real file");
	targets.slice(1).forEach(({ path }, index) => {
		expect(readFileSync(path)).toEqual(unchanged[index]);
	});
	expect(existsSync(managedBaileysCompatReceiptPath(fixture))).toBe(false);
});

it("snapshots the Hermes dependency tree only when isolated npm ci may replace it", () => {
	const fixture = createArtifactFixture("hermes");
	const bridgeRoot = join(fixture.appRoot, "scripts", "whatsapp-bridge");
	const nodeModules = join(bridgeRoot, "node_modules");
	const exactTargets = managedBaileysCompatMutationTargets(fixture);

	expect(exactTargets).toContain(join(nodeModules, ".hermes-pkg-hash"));
	expect(exactTargets).not.toContain(nodeModules);
	rmSync(join(fixture.baileysRoot, "package.json"));
	expect(managedBaileysCompatMutationTargets(fixture)).toEqual([nodeModules]);
});

it("uses an explicitly mocked local npm for missing pristine Hermes dependencies", () => {
	const fixture = createArtifactFixture("hermes");
	const bridgeRoot = join(fixture.appRoot, "scripts", "whatsapp-bridge");
	const nodeModules = join(bridgeRoot, "node_modules");
	const managedNpm = join(fixture.home, ".local", "bin", "npm");
	const pristineFiles = [
		["package.json", readFileSync(join(fixture.baileysRoot, "package.json"), "utf8")],
		...MANAGED_BAILEYS_STATIC_PATCH_TARGETS.map((target) => [
			target.relativePath,
			readFileSync(join(fixture.baileysRoot, target.relativePath), "utf8"),
		]),
	];
	mkdirSync(dirname(managedNpm), { recursive: true });
	writeFileSync(
		managedNpm,
		`#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const destination = join(process.cwd(), "node_modules", "@whiskeysockets", "baileys");
for (const [relativePath, content] of ${JSON.stringify(pristineFiles)}) {
  const path = join(destination, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
writeFileSync(join(process.cwd(), "npm-invoked"), process.argv.slice(2).join(" "));
`,
	);
	chmodSync(managedNpm, 0o755);
	rmSync(nodeModules, { recursive: true });

	expect(reconcile(fixture).status).toBe("applied");
	expect(readFileSync(join(bridgeRoot, "npm-invoked"), "utf8")).toBe(
		"ci --ignore-scripts --silent",
	);
	assertTargetState(fixture, "postimage");
});

it("executes patched socket routing without mutating consumer HTTP options", () => {
	const fixture = createArtifactFixture("openclaw");
	reconcile(fixture);
	const socketPath = join(fixture.baileysRoot, "lib/Socket/socket.js");
	const userConfig = socketConfig({
		waWebSocketUrl: "wss://consumer.example/custom",
		auth: { creds: { additionalData: { unrelated: true } } },
	});
	const userSocket = executePatchedSocketPrologue(socketPath, userConfig);
	expect(String(userSocket.url)).toBe("wss://consumer.example/custom");
	expect(userSocket.webSocketConfig).toBe(userConfig);
	expect(userSocket.noiseConfig.authCert).toBeUndefined();

	const metadata = managedMetadata("clawdi_0123456789abcdef0123456789abcdef", 73);
	const managedConfig = socketConfig({
		waWebSocketUrl: "wss://consumer.example/must-not-use",
		options: { headers: { "user-agent": "audited-client" } },
		auth: { creds: { additionalData: { "clawdi.managedWhatsAppSocket": metadata } } },
	});
	const managedSocket = executePatchedSocketPrologue(socketPath, managedConfig);
	expect(String(managedSocket.url)).toBe(rc13DefaultWebSocketUrl);
	expect(managedSocket.webSocketConfig).not.toBe(managedConfig);
	expect(managedSocket.webSocketConfig.options?.headers).toEqual({
		"user-agent": "audited-client",
		"x-clawdi-whatsapp-link-capability": metadata.capability,
	});
	expect(managedConfig.options?.headers).toEqual({ "user-agent": "audited-client" });
	expect(managedSocket.noiseConfig.authCert).toEqual(metadata.authCert);
	expect(() =>
		executePatchedSocketPrologue(
			socketPath,
			socketConfig({
				auth: {
					creds: {
						additionalData: { "clawdi.managedWhatsAppSocket": { ...metadata, extra: true } },
					},
				},
			}),
		),
	).toThrow("Invalid Clawdi managed WhatsApp socket metadata");
});

it("keeps managed upgrade identity out of real rc13 media fetch", async () => {
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
			{ headers: { "user-agent": "audited-client" } },
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
	expect(fetchInit?.headers).toEqual({ "user-agent": "audited-client" });
	expect(JSON.stringify(fetchInit)).not.toContain("x-clawdi-whatsapp-link-capability");
});

it("executes official Noise trust by default and the managed public key plus serial when present", async () => {
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
	expect(harness.verify(undefined, officialSerial).intermediateAuthorityKey).toEqual(officialKey);
	expect(() => harness.verify(undefined, officialSerial + 1)).toThrow("certification match failed");

	const customCert = managedMetadata("clawdi_0123456789abcdef0123456789abcdef", 73).authCert;
	expect(harness.verify(customCert, customCert.SERIAL).intermediateAuthorityKey).toEqual(
		customCert.PUBLIC_KEY,
	);
	expect(() => harness.verify(customCert, customCert.SERIAL + 1)).toThrow(
		"certification match failed",
	);
});

describe.each(["openclaw", "hermes"] as const)("stock %s auth reconstruction", (runtime) => {
	it("preserves namespaced additionalData through save and rereads it on reconnect", async () => {
		const fixture = createArtifactFixture(runtime);
		reconcile(fixture);
		const authDir = join(fixture.root, `auth-${runtime}`);
		const firstMetadata = managedMetadata("clawdi_0123456789abcdef0123456789abcdef", 11);
		await writeStockCreds(authDir, {
			additionalData: { unrelated: "preserved", "clawdi.managedWhatsAppSocket": firstMetadata },
		});
		const initialAuth = await loadStockAuth(authDir);
		const initial = executePatchedSocketPrologue(
			join(fixture.baileysRoot, "lib/Socket/socket.js"),
			socketConfig({ auth: initialAuth.state }),
		);
		expect(managedCapability(initial)).toBe(firstMetadata.capability);

		const secondMetadata = managedMetadata("clawdi_fedcba9876543210fedcba9876543210", 22);
		initialAuth.state.creds.additionalData["clawdi.managedWhatsAppSocket"] = secondMetadata;
		initialAuth.state.creds.accountSyncCounter = 2;
		if (runtime === "hermes") {
			await initialAuth.saveCreds();
		} else {
			await saveOpenClawStyleCreds(authDir, initialAuth.state.creds);
		}

		const reconnectAuth = await loadStockAuth(authDir);
		const reconnect = executePatchedSocketPrologue(
			join(fixture.baileysRoot, "lib/Socket/socket.js"),
			socketConfig({ auth: reconnectAuth.state }),
		);
		expect(managedCapability(reconnect)).toBe(secondMetadata.capability);
		expect(reconnect.noiseConfig.authCert?.PUBLIC_KEY).toEqual(Buffer.alloc(32, 22));
		expect(reconnectAuth.state.creds.additionalData.unrelated).toBe("preserved");
		const persistedMetadata =
			reconnectAuth.state.creds.additionalData["clawdi.managedWhatsAppSocket"];
		if (!persistedMetadata || typeof persistedMetadata !== "object") {
			throw new Error("persisted managed metadata is missing");
		}
		const persistedCert = Reflect.get(persistedMetadata, "authCert");
		if (!persistedCert || typeof persistedCert !== "object") {
			throw new Error("persisted managed authority is missing");
		}
		expect(Buffer.isBuffer(Reflect.get(persistedCert, "PUBLIC_KEY"))).toBe(true);
	});
});

function reconcile(fixture: ArtifactFixture) {
	return reconcileManagedBaileysCompatibility({
		desiredRuntime: fixture.runtime,
		home: fixture.home,
		appRoot: fixture.appRoot,
		paths: fixture,
	});
}

function rollback(fixture: ArtifactFixture) {
	return reconcileManagedBaileysCompatibility({
		desiredRuntime: null,
		home: fixture.home,
		paths: fixture,
	});
}

function createArtifactFixture(
	runtime: ManagedBaileysRuntime,
	version = "7.0.0-rc13",
): ArtifactFixture {
	const root = mkdtempSync(join(tmpdir(), `clawdi-managed-baileys-${runtime}-`));
	temporaryRoots.push(root);
	const home = join(root, "home");
	const installInventory = join(root, "state", "install-inventory");
	const appRoot =
		runtime === "openclaw" ? join(home, ".openclaw") : join(home, ".hermes", "hermes-agent");
	const bridgeRoot = join(appRoot, "scripts", "whatsapp-bridge");
	const baileysRoot =
		runtime === "openclaw"
			? join(appRoot, "extensions", "whatsapp", "node_modules", "baileys")
			: join(bridgeRoot, "node_modules", "@whiskeysockets", "baileys");
	for (const target of MANAGED_BAILEYS_STATIC_PATCH_TARGETS) {
		const destination = join(baileysRoot, target.relativePath);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(pristineBaileysRoot, target.relativePath), destination);
	}
	writeBaileysIdentity({ runtime, root, home, appRoot, baileysRoot, installInventory }, version);
	if (runtime === "hermes") {
		writeJson(join(bridgeRoot, "package.json"), { name: "hermes-whatsapp-bridge" });
		writeJson(join(bridgeRoot, "package-lock.json"), { lockfileVersion: 3 });
	}
	return { runtime, root, home, appRoot, baileysRoot, installInventory };
}

function writeBaileysIdentity(fixture: ArtifactFixture, version: string): void {
	writeJson(join(fixture.baileysRoot, "package.json"), {
		name: fixture.runtime === "openclaw" ? "baileys" : "@whiskeysockets/baileys",
		version,
	});
}

function artifactTargets(fixture: ArtifactFixture) {
	return MANAGED_BAILEYS_STATIC_PATCH_TARGETS.map((target) => ({
		target,
		path: join(fixture.baileysRoot, target.relativePath),
	}));
}

function assertTargetState(fixture: ArtifactFixture, state: "preimage" | "postimage"): void {
	for (const { target, path } of artifactTargets(fixture)) {
		expect(sha256File(path)).toBe(
			state === "preimage" ? target.preimageSha256 : target.postimageSha256,
		);
	}
}

function restorePristineTarget(
	entry: ReturnType<typeof artifactTargets>[number] | undefined,
): void {
	if (!entry) throw new Error("missing fixture target");
	copyFileSync(join(pristineBaileysRoot, entry.target.relativePath), entry.path);
}

function readReceipt(fixture: ArtifactFixture): {
	artifact: { baileys: { observedVersion: string } };
} & Record<string, unknown> {
	return JSON.parse(readFileSync(managedBaileysCompatReceiptPath(fixture), "utf8"));
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface SocketHarnessConfig {
	waWebSocketUrl: string;
	options?: { headers?: Record<string, string> };
	auth: { creds: Record<string, unknown> };
	shouldSyncHistoryMessage: (value: unknown) => boolean;
	logger: { warn(): void };
	[key: string]: unknown;
}

interface SocketHarnessResult {
	url: URL;
	webSocketConfig: SocketHarnessConfig;
	noiseConfig: { authCert?: { SERIAL: number; PUBLIC_KEY: Buffer } };
}

function socketConfig(overrides: Partial<SocketHarnessConfig>): SocketHarnessConfig {
	return {
		waWebSocketUrl: rc13DefaultWebSocketUrl,
		auth: { creds: {} },
		shouldSyncHistoryMessage: () => true,
		logger: { warn() {} },
		...overrides,
	};
}

function executePatchedSocketPrologue(
	path: string,
	config: SocketHarnessConfig,
): SocketHarnessResult {
	const source = readFileSync(path, "utf8");
	const helpersStart = source.indexOf("const CLAWDI_MANAGED_SOCKET_KEY");
	const helpersEnd = source.indexOf("/**\n * Connects to WA servers", helpersStart);
	const socketStart = source.indexOf("export const makeSocket =", helpersEnd);
	const connectLine = "    ws.connect();";
	const socketEnd = source.indexOf(connectLine, socketStart) + connectLine.length;
	if (helpersStart < 0 || helpersEnd < 0 || socketStart < 0 || socketEnd < connectLine.length) {
		throw new Error("patched rc13 socket prologue is missing");
	}
	const helpers = source.slice(helpersStart, helpersEnd);
	const prologue = source
		.slice(socketStart, socketEnd)
		.replace("export const makeSocket =", "const makeSocket =");
	let capturedWebSocketConfig: SocketHarnessConfig | undefined;
	let capturedNoiseConfig: SocketHarnessResult["noiseConfig"] | undefined;
	class WebSocketClient {
		constructor(
			readonly url: URL,
			readonly config: SocketHarnessConfig,
		) {
			capturedWebSocketConfig = config;
		}
		connect() {}
	}
	const factory = Function(
		"Boom",
		"BinaryInfo",
		"PROCESSABLE_HISTORY_TYPES",
		"generateMdTagPrefix",
		"DisconnectReason",
		"Curve",
		"makeNoiseHandler",
		"NOISE_WA_HEADER",
		"DEFAULT_CONNECTION_CONFIG",
		"WebSocketClient",
		`${helpers}\n${prologue}\nreturn { url, noise, ws };\n};\nreturn makeSocket;`,
	);
	const makeSocket = Reflect.apply(factory, undefined, [
		class Boom extends Error {},
		class BinaryInfo {},
		[],
		() => "tag",
		{ loggedOut: 401 },
		{ generateKeyPair: () => ({ private: Buffer.alloc(32), public: Buffer.alloc(32) }) },
		(noiseConfig: SocketHarnessResult["noiseConfig"]) => {
			capturedNoiseConfig = noiseConfig;
			return {};
		},
		Buffer.from("WA"),
		rc13DefaultConnectionConfig,
		WebSocketClient,
	]);
	if (typeof makeSocket !== "function") throw new Error("patched makeSocket did not compile");
	const output = Reflect.apply(makeSocket, undefined, [config]);
	if (!output || typeof output !== "object" || !capturedWebSocketConfig || !capturedNoiseConfig) {
		throw new Error("patched socket prologue did not execute");
	}
	const url = Reflect.get(output, "url");
	if (!(url instanceof URL)) throw new Error("patched socket URL is missing");
	return { url, webSocketConfig: capturedWebSocketConfig, noiseConfig: capturedNoiseConfig };
}

function managedMetadata(capability: string, keyByte: number) {
	return {
		schemaVersion: "clawdi.managedWhatsAppSocket.v1",
		capability,
		authCert: {
			SERIAL: keyByte,
			ISSUER: "ClawdiManagedLink",
			PUBLIC_KEY: Buffer.alloc(32, keyByte),
		},
	};
}

function managedCapability(result: SocketHarnessResult): unknown {
	return result.webSocketConfig.options?.headers?.["x-clawdi-whatsapp-link-capability"];
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
			new SourceTextModule(`export class Boom extends Error {}`, {
				context,
				identifier: "boom",
			}),
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
	if (typeof makeNoiseHandler !== "function") throw new Error("patched makeNoiseHandler missing");
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
			if (typeof processHandshake !== "function") throw new Error("processHandshake is missing");
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

async function stockAuthModules() {
	const authModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Utils/use-multi-file-auth-state.js")).href
	);
	const genericsModule = await import(
		pathToFileURL(join(pristineBaileysRoot, "lib/Utils/generics.js")).href
	);
	const useMultiFileAuthState = Reflect.get(authModule, "useMultiFileAuthState");
	const BufferJSON = Reflect.get(genericsModule, "BufferJSON");
	if (typeof useMultiFileAuthState !== "function" || !BufferJSON) {
		throw new Error("rc13 auth-state exports are missing");
	}
	return { useMultiFileAuthState, BufferJSON };
}

async function writeStockCreds(authDir: string, creds: Record<string, unknown>): Promise<void> {
	const { BufferJSON } = await stockAuthModules();
	mkdirSync(authDir, { recursive: true });
	writeFileSync(join(authDir, "creds.json"), JSON.stringify(creds, BufferJSON.replacer));
}

async function loadStockAuth(authDir: string): Promise<{
	state: {
		creds: Record<string, unknown> & {
			additionalData: Record<string, unknown>;
			accountSyncCounter?: number;
		};
	};
	saveCreds: () => Promise<void>;
}> {
	const { useMultiFileAuthState } = await stockAuthModules();
	return Reflect.apply(useMultiFileAuthState, undefined, [authDir]);
}

async function saveOpenClawStyleCreds(
	authDir: string,
	creds: Record<string, unknown>,
): Promise<void> {
	const { BufferJSON } = await stockAuthModules();
	writeFileSync(join(authDir, "creds.json"), JSON.stringify(creds, BufferJSON.replacer));
}
