import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { RuntimePaths } from "./paths";
import { makeRuntimeUserOwned, spawnRuntimeUserCommand } from "./runtime-user-command";

export const MANAGED_BAILEYS_PATCH_REVISION = "clawdi.managedBaileysCompat.v1";
export const MANAGED_WHATSAPP_SOCKET_CONFIG_FILE = ".clawdi-managed-whatsapp-socket.json";

const BAILEYS_VERSION = "7.0.0-rc13";
const OPENCLAW_WHATSAPP_VERSION = "2026.7.1";
const HERMES_VERSION = "0.19.1";
const RECEIPT_FILE = "managed-baileys-compat.json";

export type ManagedBaileysRuntime = "openclaw" | "hermes";

interface StrictReplacement {
	before: string;
	after: string;
}

interface StaticPatchTarget {
	relativePath: string;
	preimageSha256: string;
	postimageSha256: string;
	replacements: readonly StrictReplacement[];
}

interface PackageIdentity {
	path: string;
	name: string;
	version: string;
}

interface ManagedBaileysArtifact {
	runtime: ManagedBaileysRuntime;
	root: string;
	consumer: PackageIdentity;
	baileys: PackageIdentity;
	targets: readonly StaticPatchTarget[];
}

export interface ManagedBaileysPatchReceiptTarget {
	relativePath: string;
	preimageSha256: string;
	postimageSha256: string;
}

export interface ManagedBaileysPatchReceiptArtifact {
	runtime: ManagedBaileysRuntime;
	artifactRoot: string;
	consumer: Omit<PackageIdentity, "path">;
	baileys: Omit<PackageIdentity, "path">;
	targets: ManagedBaileysPatchReceiptTarget[];
}

export interface ManagedBaileysPatchReceipt {
	schemaVersion: "clawdi.managedBaileysPatchReceipt.v2";
	patchRevision: typeof MANAGED_BAILEYS_PATCH_REVISION;
	artifact: ManagedBaileysPatchReceiptArtifact;
}

export type ManagedBaileysReconcileResult =
	| { status: "inert"; receiptPath: string }
	| { status: "already-patched"; receiptPath: string }
	| { status: "receipt-recovered"; receiptPath: string }
	| { status: "applied"; receiptPath: string }
	| { status: "rolled-back"; receiptPath: string }
	| { status: "rollback-refused"; receiptPath: string; errors: string[] };

const BAILEYS_TARGETS = [
	{
		relativePath: "lib/Types/Socket.d.ts",
		preimageSha256: "3555af5f3f73ceae7bb1b77018620b6a8cdfb21dc00029b4d655956eb86bb300",
		postimageSha256: "dbcfaa83edbc660dc527d2d5d248219f3e7575660c638b7ae409cb4185199cd3",
		replacements: [
			{
				before: "export type WABrowserDescription = [string, string, string];\n",
				after:
					"export type WABrowserDescription = [string, string, string];\n" +
					"export type NoiseCertificateAuthority = {\n" +
					"    SERIAL: number;\n" +
					"    ISSUER: string;\n" +
					"    PUBLIC_KEY: Uint8Array;\n" +
					"};\n",
			},
			{
				before:
					"export type SocketConfig = {\n    /** the WS url to connect to WA */\n    waWebSocketUrl: string | URL;\n",
				after:
					"export type SocketConfig = {\n" +
					"    /** certificate authority used for Noise intermediate verification */\n" +
					"    authCert?: NoiseCertificateAuthority;\n" +
					"    /** headers applied exclusively to the WebSocket upgrade */\n" +
					"    webSocketHeaders?: Record<string, string>;\n" +
					"    /** the WS url to connect to WA */\n" +
					"    waWebSocketUrl: string | URL;\n",
			},
		],
	},
	{
		relativePath: "lib/Socket/socket.js",
		preimageSha256: "ab9b68888e123ad683dbc26555fc928400c1526c93ec6b66853f2ba30f8177a9",
		postimageSha256: "9a35caddfa3b1e10d7ea3f35208883ddd489b4b2505978d17e1e6eb5d0af821a",
		replacements: [
			{
				before: "        routingInfo: authState?.creds?.routingInfo\n",
				after:
					"        routingInfo: authState?.creds?.routingInfo,\n        authCert: config.authCert\n",
			},
		],
	},
	{
		relativePath: "lib/Socket/Client/websocket.js",
		preimageSha256: "3344bcf808751d4cf1d25970ad5945c130e7f14d22814f7c2f6ac1a7b05e7de0",
		postimageSha256: "8564bbd83a93a2d06832ba5fed4df08c411c05cc69c663600e65b5851173276d",
		replacements: [
			{
				before: "            headers: this.config.options?.headers,\n",
				after:
					"            headers: {\n                ...this.config.options?.headers,\n                ...this.config.webSocketHeaders\n            },\n",
			},
		],
	},
	{
		relativePath: "lib/Utils/noise-handler.js",
		preimageSha256: "970f9526ce0e5a6bebf937328b3d835966a9282c0d232f31b5c0bb283531afe8",
		postimageSha256: "be9d357b337b20f2d678c68d1c989091187a8fa6f767af92645dba05b827f206",
		replacements: [
			{
				before:
					"export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }) => {\n    logger = logger.child({ class: 'ns' });\n",
				after:
					"export const makeNoiseHandler = ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo, authCert }) => {\n    const trustedCert = authCert ?? WA_CERT_DETAILS;\n    logger = logger.child({ class: 'ns' });\n",
			},
			{
				before: "            if (issuerSerial !== WA_CERT_DETAILS.SERIAL) {\n",
				after: "            if (issuerSerial !== trustedCert.SERIAL) {\n",
			},
			{
				before:
					"            const verifyIntermediate = Curve.verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details, certIntermediate.signature);\n",
				after:
					"            const verifyIntermediate = Curve.verify(trustedCert.PUBLIC_KEY, certIntermediate.details, certIntermediate.signature);\n",
			},
		],
	},
	{
		relativePath: "lib/Utils/noise-handler.d.ts",
		preimageSha256: "a556ca0b67c3448769ad5ed0d59acbf566a21115fa107cd582b1dcb28c4fd516",
		postimageSha256: "998d333b308823e255c3faad0e7abdf561720c931a3f29d25e786091262456e3",
		replacements: [
			{
				before: "import type { KeyPair } from '../Types/index.js';\n",
				after: "import type { KeyPair, NoiseCertificateAuthority } from '../Types/index.js';\n",
			},
			{
				before:
					"export declare const makeNoiseHandler: ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }: {\n",
				after:
					"export declare const makeNoiseHandler: ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo, authCert }: {\n",
			},
			{
				before: "    routingInfo?: Buffer | undefined;\n",
				after: "    routingInfo?: Buffer | undefined;\n    authCert?: NoiseCertificateAuthority;\n",
			},
		],
	},
] as const satisfies readonly StaticPatchTarget[];

const OPENCLAW_CONSUMER_TARGET = {
	relativePath: "dist/session-DriaHt7V.js",
	preimageSha256: "21417f0271cf1ae63a6fd4f05510b78755e4b1870ae087a1d23c68adc128de7a",
	postimageSha256: "a11ad39e8b320ac86524c04f668e5f25193920efc40a3cb6d6f20a975cc89d16",
	replacements: [
		{
			before:
				'import { i as makeWASocket, n as fetchLatestBaileysVersion, o as useMultiFileAuthState, r as makeCacheableSignalKeyStore } from "./session.runtime-CyooSQvj.js";\n',
			after:
				'import { t as BufferJSON, i as makeWASocket, n as fetchLatestBaileysVersion, o as useMultiFileAuthState, r as makeCacheableSignalKeyStore } from "./session.runtime-CyooSQvj.js";\n',
		},
		{
			before: 'import { randomUUID } from "node:crypto";\n',
			after:
				'import { randomUUID } from "node:crypto";\nimport { readFileSync } from "node:fs";\nimport { join } from "node:path";\n',
		},
		{
			before: 'const OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV = "OPENCLAW_WHATSAPP_WEB_SOCKET_URL";\n',
			after:
				'const OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV = "OPENCLAW_WHATSAPP_WEB_SOCKET_URL";\n' +
				'const CLAWDI_MANAGED_SOCKET_CONFIG = ".clawdi-managed-whatsapp-socket.json";\n' +
				'const CLAWDI_LINK_CAPABILITY_HEADER = "x-clawdi-whatsapp-link-capability";\n' +
				"function managedSocketOptions(authDir) {\n" +
				"\tlet value;\n" +
				"\ttry {\n" +
				'\t\tvalue = JSON.parse(readFileSync(join(authDir, CLAWDI_MANAGED_SOCKET_CONFIG), "utf8"), BufferJSON.reviver);\n' +
				"\t} catch (error) {\n" +
				'\t\tif (error?.code === "ENOENT") return null;\n' +
				`\t\tthrow new Error(\`Invalid managed WhatsApp socket config: \${String(error)}\`);\n` +
				"\t}\n" +
				'\tif (value?.schemaVersion !== "clawdi.managedWhatsAppSocket.v1" || typeof value.capability !== "string" || !Number.isInteger(value.authCert?.SERIAL) || typeof value.authCert?.ISSUER !== "string" || !Buffer.isBuffer(value.authCert?.PUBLIC_KEY) || value.authCert.PUBLIC_KEY.length !== 32) throw new Error("Invalid managed WhatsApp socket config");\n' +
				"\treturn { authCert: value.authCert, webSocketHeaders: { [CLAWDI_LINK_CAPABILITY_HEADER]: value.capability } };\n" +
				"}\n",
		},
		{
			before:
				"\tconst waWebSocketUrl = resolveWaWebSocketUrl(opts.waWebSocketUrl) ?? resolveEnvWaWebSocketUrl();\n",
			after:
				"\tconst managedOptions = managedSocketOptions(authDir);\n\tconst waWebSocketUrl = managedOptions ? void 0 : resolveWaWebSocketUrl(opts.waWebSocketUrl) ?? resolveEnvWaWebSocketUrl();\n",
		},
		{
			before: "\t\tfetchAgent,\n\t\t...waWebSocketUrl ? { waWebSocketUrl } : {},\n",
			after:
				"\t\tfetchAgent,\n\t\t...managedOptions ?? {},\n\t\t...waWebSocketUrl ? { waWebSocketUrl } : {},\n",
		},
	],
} as const satisfies StaticPatchTarget;

const HERMES_CONSUMER_TARGET = {
	relativePath: "bridge.js",
	preimageSha256: "9e1c4745da7d385a56fe3e48ff510e94f577ccd4cd01daa66c02d69267226185",
	postimageSha256: "829766d530f9f52a2c5e5c224867379c731ab1214853662fc9222ac50a2fd4f9",
	replacements: [
		{
			before:
				"import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, getAggregateVotesInPollMessage, decryptPollVote, getKeyAuthor, jidNormalizedUser } from '@whiskeysockets/baileys';\n",
			after:
				"import { BufferJSON, makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, getAggregateVotesInPollMessage, decryptPollVote, getKeyAuthor, jidNormalizedUser } from '@whiskeysockets/baileys';\n",
		},
		{
			before:
				"const SESSION_DIR = getArg('session', path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'session'));\n",
			after:
				"const SESSION_DIR = getArg('session', path.join(process.env.HOME || '~', '.hermes', 'whatsapp', 'session'));\n" +
				"const CLAWDI_MANAGED_SOCKET_CONFIG = '.clawdi-managed-whatsapp-socket.json';\n" +
				"const CLAWDI_LINK_CAPABILITY_HEADER = 'x-clawdi-whatsapp-link-capability';\n" +
				"function managedSocketOptions() {\n" +
				"  let value;\n" +
				"  try {\n" +
				"    value = JSON.parse(readFileSync(path.join(SESSION_DIR, CLAWDI_MANAGED_SOCKET_CONFIG), 'utf8'), BufferJSON.reviver);\n" +
				"  } catch (error) {\n" +
				"    if (error?.code === 'ENOENT') return {};\n" +
				`    throw new Error(\`Invalid managed WhatsApp socket config: \${String(error)}\`);\n` +
				"  }\n" +
				"  if (value?.schemaVersion !== 'clawdi.managedWhatsAppSocket.v1' || typeof value.capability !== 'string' || !Number.isInteger(value.authCert?.SERIAL) || typeof value.authCert?.ISSUER !== 'string' || !Buffer.isBuffer(value.authCert?.PUBLIC_KEY) || value.authCert.PUBLIC_KEY.length !== 32) throw new Error('Invalid managed WhatsApp socket config');\n" +
				"  return { authCert: value.authCert, webSocketHeaders: { [CLAWDI_LINK_CAPABILITY_HEADER]: value.capability } };\n" +
				"}\n",
		},
		{
			before:
				"    markOnlineOnConnect: false,\n    // Required for Baileys 7.x: without this, incoming messages that need\n",
			after:
				"    markOnlineOnConnect: false,\n    ...managedSocketOptions(),\n    // Required for Baileys 7.x: without this, incoming messages that need\n",
		},
	],
} as const satisfies StaticPatchTarget;

export function managedBaileysCompatReceiptPath(
	paths: Pick<RuntimePaths, "installInventory">,
): string {
	return join(paths.installInventory, RECEIPT_FILE);
}

export function managedBaileysCompatMutationTargets(input: {
	runtime: ManagedBaileysRuntime;
	home: string;
	appRoot: string;
}): string[] {
	const artifact = resolveArtifact(input);
	const targets = artifact.targets.map((target) => join(artifact.root, target.relativePath));
	if (input.runtime !== "hermes") return targets;
	const nodeModules = join(artifact.root, "node_modules");
	if (!existsSync(join(hermesManagedBaileysPackageRoot(input.appRoot), "package.json"))) {
		return [join(artifact.root, HERMES_CONSUMER_TARGET.relativePath), nodeModules];
	}
	return [...targets, join(nodeModules, ".hermes-pkg-hash")];
}

export function hermesManagedBaileysPackageRoot(appRoot: string): string {
	return join(appRoot, "scripts", "whatsapp-bridge", "node_modules", "@whiskeysockets", "baileys");
}

export function reconcileManagedBaileysCompatibility(input: {
	desiredRuntime: ManagedBaileysRuntime | null;
	home: string;
	appRoot?: string;
	paths: Pick<RuntimePaths, "installInventory">;
}): ManagedBaileysReconcileResult {
	const receiptPath = managedBaileysCompatReceiptPath(input.paths);
	if (!input.desiredRuntime) return rollbackManagedBaileysCompatibility(receiptPath, input);
	if (!input.appRoot) {
		throw new Error(`managed WhatsApp ${input.desiredRuntime} artifact root is unavailable`);
	}
	if (input.desiredRuntime === "hermes") {
		ensureHermesManagedBaileysDependencies(input.home, input.appRoot);
	}
	const artifact = resolveArtifact({
		runtime: input.desiredRuntime,
		home: input.home,
		appRoot: input.appRoot,
	});
	verifyArtifactIdentity(artifact);
	const targetStates = artifact.targets.map((target) => classifyTarget(artifact, target));
	const unknown = targetStates.filter((state) => state.state === "unknown");
	if (unknown.length > 0) {
		throw new Error(
			`managed WhatsApp compatibility patch refused drifted ${input.desiredRuntime} artifacts: ${unknown
				.map((state) => `${state.path} (${state.sha256})`)
				.join(", ")}`,
		);
	}
	const existingReceipt = readReceipt(receiptPath);
	const receipt = buildReceipt(artifact);
	const receiptMatches = existingReceipt
		? receiptArtifactMatches(existingReceipt.artifact, artifact)
		: false;
	if (existingReceipt && !receiptMatches) {
		const rollback = rollbackManagedBaileysCompatibility(receiptPath, input);
		if (rollback.status === "rollback-refused") {
			throw new Error(
				`managed WhatsApp compatibility could not recover the previous artifact: ${rollback.errors.join(
					", ",
				)}`,
			);
		}
	}
	const applied = targetStates.some((state) => state.state === "preimage");
	if (applied || !receiptMatches) writeReceiptDurable(receiptPath, receipt);
	if (applied) applyArtifactTargets(artifact, targetStates);
	if (artifact.runtime === "hermes") writeHermesDependencyStamp(artifact.root);
	return {
		status: applied ? "applied" : receiptMatches ? "already-patched" : "receipt-recovered",
		receiptPath,
	};
}

function rollbackManagedBaileysCompatibility(
	receiptPath: string,
	input: { home: string; paths: Pick<RuntimePaths, "installInventory"> },
): ManagedBaileysReconcileResult {
	const receipt = readReceipt(receiptPath);
	if (!receipt) return { status: "inert", receiptPath };
	const errors: string[] = [];
	const rollbackEntries: Array<{
		path: string;
		expectedSha256: string;
		content: string;
	}> = [];
	const auditedStates: Array<{ path: string; expectedSha256: string }> = [];
	const artifactReceipt = receipt.artifact;
	const appRoot = join(
		input.home,
		...(artifactReceipt.runtime === "openclaw" ? [".openclaw"] : [".hermes", "hermes-agent"]),
	);
	const artifact = resolveArtifact({
		runtime: artifactReceipt.runtime,
		home: input.home,
		appRoot,
	});
	if (!receiptArtifactMatches(artifactReceipt, artifact)) {
		errors.push("managed WhatsApp compatibility receipt does not match the audited artifact");
	} else if (directoryEntryExists(artifact.root)) {
		try {
			verifyArtifactIdentity(artifact);
		} catch (error) {
			errors.push(String(error));
		}
		if (errors.length === 0) {
			for (const target of artifact.targets) {
				try {
					const state = classifyTarget(artifact, target);
					auditedStates.push({ path: state.path, expectedSha256: state.sha256 });
					if (state.state === "preimage") continue;
					if (state.state === "unknown") {
						errors.push(`${state.path} has unknown hash ${state.sha256}`);
						continue;
					}
					const pristine = applyReplacements(
						readFileSync(state.path, "utf8"),
						target.replacements,
						true,
					);
					if (sha256String(pristine) !== target.preimageSha256) {
						errors.push(`${state.path} inverse patch did not reproduce the audited preimage`);
						continue;
					}
					rollbackEntries.push({
						path: state.path,
						expectedSha256: state.sha256,
						content: pristine,
					});
				} catch (error) {
					errors.push(String(error));
				}
			}
		}
	}
	if (errors.length > 0) return { status: "rollback-refused", receiptPath, errors };
	replaceTargetContents(rollbackEntries, auditedStates);
	rmSync(receiptPath, { force: true });
	fsyncDirectory(dirname(receiptPath));
	return { status: "rolled-back", receiptPath };
}

function ensureHermesManagedBaileysDependencies(home: string, appRoot: string): void {
	const expectedAppRoot = join(home, ".hermes", "hermes-agent");
	if (resolve(appRoot) !== resolve(expectedAppRoot)) {
		throw new Error(`managed WhatsApp Hermes app root must be ${expectedAppRoot}`);
	}
	const bridgeRoot = join(appRoot, "scripts", "whatsapp-bridge");
	const packagePath = join(
		bridgeRoot,
		"node_modules",
		"@whiskeysockets",
		"baileys",
		"package.json",
	);
	if (existsSync(packagePath)) return;
	for (const required of ["package.json", "package-lock.json"] as const) {
		if (!existsSync(join(bridgeRoot, required))) {
			throw new Error(`managed WhatsApp Hermes bridge is missing ${required}`);
		}
	}
	const managedNpm = join(home, ".local", "bin", "npm");
	const result = spawnRuntimeUserCommand(
		existsSync(managedNpm) ? managedNpm : "npm",
		["ci", "--ignore-scripts", "--silent"],
		home,
		bridgeRoot,
		{ timeoutMs: 300_000 },
	);
	if (result.status !== 0) {
		const detail = String(result.stderr || result.stdout || "npm ci failed")
			.trim()
			.slice(-1_000);
		throw new Error(`managed WhatsApp Hermes dependency install failed: ${detail}`);
	}
	if (!existsSync(packagePath)) {
		throw new Error("managed WhatsApp Hermes dependency install did not produce Baileys");
	}
}

function writeHermesDependencyStamp(bridgeRoot: string): void {
	const packageJson = join(bridgeRoot, "package.json");
	const stamp = join(bridgeRoot, "node_modules", ".hermes-pkg-hash");
	const content = `${sha256File(packageJson).slice(0, 16)}\n`;
	if (existsSync(stamp)) {
		if (!lstatSync(stamp).isFile() || realpathSync(stamp) !== resolve(stamp)) {
			throw new Error(`managed WhatsApp Hermes dependency stamp must be a real file: ${stamp}`);
		}
		if (readFileSync(stamp, "utf8") === content) return;
	}
	writeDurableAtomic(stamp, content, 0o644, 0o755);
	makeRuntimeUserOwned(stamp);
}

function resolveArtifact(input: {
	runtime: ManagedBaileysRuntime;
	home: string;
	appRoot: string;
}): ManagedBaileysArtifact {
	if (input.runtime === "openclaw") {
		const root = join(input.home, ".openclaw", "extensions", "whatsapp");
		return {
			runtime: "openclaw",
			root,
			consumer: {
				path: join(root, "package.json"),
				name: "@openclaw/whatsapp",
				version: OPENCLAW_WHATSAPP_VERSION,
			},
			baileys: {
				path: join(root, "node_modules", "baileys", "package.json"),
				name: "baileys",
				version: BAILEYS_VERSION,
			},
			targets: [
				OPENCLAW_CONSUMER_TARGET,
				...BAILEYS_TARGETS.map((target) => ({
					...target,
					relativePath: join("node_modules", "baileys", target.relativePath),
				})),
			],
		};
	}
	const expectedAppRoot = join(input.home, ".hermes", "hermes-agent");
	if (resolve(input.appRoot) !== resolve(expectedAppRoot)) {
		throw new Error(`managed WhatsApp Hermes app root must be ${expectedAppRoot}`);
	}
	const root = join(input.appRoot, "scripts", "whatsapp-bridge");
	return {
		runtime: "hermes",
		root,
		consumer: {
			path: join(input.appRoot, "pyproject.toml"),
			name: "hermes-agent",
			version: HERMES_VERSION,
		},
		baileys: {
			path: join(root, "node_modules", "@whiskeysockets", "baileys", "package.json"),
			name: "@whiskeysockets/baileys",
			version: BAILEYS_VERSION,
		},
		targets: [
			HERMES_CONSUMER_TARGET,
			...BAILEYS_TARGETS.map((target) => ({
				...target,
				relativePath: join("node_modules", "@whiskeysockets", "baileys", target.relativePath),
			})),
		],
	};
}

function verifyArtifactIdentity(artifact: ManagedBaileysArtifact): void {
	assertTrustedRealDirectory(artifact.root);
	verifyPackageIdentity(artifact.consumer, artifact.runtime === "hermes");
	verifyPackageIdentity(artifact.baileys, false);
}

function verifyPackageIdentity(identity: PackageIdentity, pyproject: boolean): void {
	if (!existsSync(identity.path)) {
		throw new Error(`managed WhatsApp compatibility artifact is missing ${identity.path}`);
	}
	if (
		!lstatSync(identity.path).isFile() ||
		realpathSync(identity.path) !== resolve(identity.path)
	) {
		throw new Error(
			`managed WhatsApp compatibility package identity must be a real file: ${identity.path}`,
		);
	}
	if (pyproject) {
		const source = readFileSync(identity.path, "utf8");
		const projectHeader = /^\[project\]\s*$/m.exec(source);
		const remainder = projectHeader
			? source.slice(projectHeader.index + projectHeader[0].length)
			: "";
		const nextSection = /^\[/m.exec(remainder)?.index ?? remainder.length;
		const project = remainder.slice(0, nextSection);
		const name = /^name = "([^"]+)"$/m.exec(project)?.[1];
		const version = /^version = "([^"]+)"$/m.exec(project)?.[1];
		if (name !== identity.name || version !== identity.version) {
			throw new Error(
				`managed WhatsApp compatibility requires ${identity.name}@${identity.version}; found ${name ?? "unknown"}@${version ?? "unknown"}`,
			);
		}
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(identity.path, "utf8"));
	} catch (error) {
		throw new Error(
			`managed WhatsApp compatibility could not read ${identity.path}: ${String(error)}`,
		);
	}
	const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	const name = record ? Reflect.get(record, "name") : null;
	const version = record ? Reflect.get(record, "version") : null;
	if (name !== identity.name || version !== identity.version) {
		throw new Error(
			`managed WhatsApp compatibility requires ${identity.name}@${identity.version}; found ${String(name)}@${String(version)}`,
		);
	}
}

function classifyTarget(artifact: ManagedBaileysArtifact, target: StaticPatchTarget) {
	const path = join(artifact.root, target.relativePath);
	if (!existsSync(path)) {
		throw new Error(`managed WhatsApp compatibility artifact is missing ${path}`);
	}
	assertTrustedRealFile(artifact.root, path);
	const sha256 = sha256File(path);
	return {
		path,
		sha256,
		state:
			sha256 === target.preimageSha256
				? ("preimage" as const)
				: sha256 === target.postimageSha256
					? ("postimage" as const)
					: ("unknown" as const),
		target,
	};
}

function applyArtifactTargets(
	artifact: ManagedBaileysArtifact,
	states: ReturnType<typeof classifyTarget>[],
): void {
	const replacements = states.flatMap((state) => {
		if (state.state !== "preimage") return [];
		const content = applyReplacements(readFileSync(state.path, "utf8"), state.target.replacements);
		if (sha256String(content) !== state.target.postimageSha256) {
			throw new Error(`static managed WhatsApp patch postimage mismatch for ${state.path}`);
		}
		return [{ path: state.path, expectedSha256: state.sha256, content }];
	});
	replaceTargetContents(
		replacements,
		states.map((state) => ({ path: state.path, expectedSha256: state.sha256 })),
	);
	for (const target of artifact.targets) {
		const path = join(artifact.root, target.relativePath);
		if (sha256File(path) !== target.postimageSha256) {
			throw new Error(`managed WhatsApp compatibility verification failed for ${path}`);
		}
	}
}

function applyReplacements(
	source: string,
	replacements: readonly StrictReplacement[],
	inverse = false,
): string {
	let output = source;
	for (const replacement of inverse ? [...replacements].reverse() : replacements) {
		const before = inverse ? replacement.after : replacement.before;
		const after = inverse ? replacement.before : replacement.after;
		const first = output.indexOf(before);
		if (first < 0 || output.indexOf(before, first + before.length) >= 0) {
			throw new Error("static managed WhatsApp patch requires exactly one audited match");
		}
		output = `${output.slice(0, first)}${after}${output.slice(first + before.length)}`;
	}
	return output;
}

function stageReplacement(path: string, content: string): string {
	const stagingPath = join(dirname(path), `.${basename(path)}.clawdi-stage-${randomUUID()}`);
	const mode = statSync(path).mode & 0o777;
	let descriptor: number | null = null;
	try {
		descriptor = openSync(stagingPath, "wx", mode);
		const bytes = Buffer.from(content);
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		chmodSync(stagingPath, mode);
		makeRuntimeUserOwned(stagingPath);
		return stagingPath;
	} catch (error) {
		rmSync(stagingPath, { force: true });
		throw error;
	} finally {
		if (descriptor !== null) closeSync(descriptor);
	}
}

function replaceTargetContents(
	entries: readonly { path: string; expectedSha256: string; content: string }[],
	auditedStates: readonly { path: string; expectedSha256: string }[] = entries,
): void {
	const staged: Array<
		(typeof entries)[number] & {
			stagingPath: string;
		}
	> = [];
	try {
		for (const entry of entries) {
			staged.push({ ...entry, stagingPath: stageReplacement(entry.path, entry.content) });
		}
		for (const entry of auditedStates) {
			if (sha256File(entry.path) !== entry.expectedSha256) {
				throw new Error(
					`managed WhatsApp compatibility artifact changed during reconcile: ${entry.path}`,
				);
			}
		}
		for (const entry of staged) {
			renameSync(entry.stagingPath, entry.path);
			makeRuntimeUserOwned(entry.path);
			fsyncDirectory(dirname(entry.path));
		}
	} finally {
		for (const entry of staged) rmSync(entry.stagingPath, { force: true });
	}
}

function writeReceiptDurable(path: string, receipt: ManagedBaileysPatchReceipt): void {
	writeDurableAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`, 0o600, 0o755);
}

function writeDurableAtomic(path: string, content: string, mode: number, dirMode: number): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: dirMode });
	const stagingPath = join(directory, `.${basename(path)}.clawdi-stage-${randomUUID()}`);
	let descriptor: number | null = null;
	try {
		descriptor = openSync(stagingPath, "wx", mode);
		const bytes = Buffer.from(content);
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = null;
		chmodSync(stagingPath, mode);
		renameSync(stagingPath, path);
		fsyncDirectory(directory);
	} finally {
		if (descriptor !== null) closeSync(descriptor);
		rmSync(stagingPath, { force: true });
	}
}

function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function assertTrustedRealDirectory(path: string): void {
	if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(path)) {
		throw new Error(`managed WhatsApp compatibility root must be a real directory: ${path}`);
	}
}

function assertTrustedRealFile(root: string, path: string): void {
	const relativePath = relative(resolve(root), resolve(path));
	if (!relativePath || relativePath.startsWith("..")) {
		throw new Error(`managed WhatsApp compatibility target is outside artifact root: ${path}`);
	}
	if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) {
		throw new Error(`managed WhatsApp compatibility target must be a real file: ${path}`);
	}
}

function buildReceipt(artifact: ManagedBaileysArtifact): ManagedBaileysPatchReceipt {
	return {
		schemaVersion: "clawdi.managedBaileysPatchReceipt.v2",
		patchRevision: MANAGED_BAILEYS_PATCH_REVISION,
		artifact: {
			runtime: artifact.runtime,
			artifactRoot: artifact.root,
			consumer: identityReceipt(artifact.consumer),
			baileys: identityReceipt(artifact.baileys),
			targets: artifact.targets.map((target) => ({
				relativePath: target.relativePath,
				preimageSha256: target.preimageSha256,
				postimageSha256: target.postimageSha256,
			})),
		},
	};
}

function identityReceipt(identity: PackageIdentity): Omit<PackageIdentity, "path"> {
	return {
		name: identity.name,
		version: identity.version,
	};
}

function receiptArtifactMatches(
	receipt: ManagedBaileysPatchReceiptArtifact | undefined,
	artifact: ManagedBaileysArtifact,
): boolean {
	if (!receipt || receipt.runtime !== artifact.runtime || receipt.artifactRoot !== artifact.root) {
		return false;
	}
	if (
		receipt.consumer.name !== artifact.consumer.name ||
		receipt.consumer.version !== artifact.consumer.version ||
		receipt.baileys.name !== artifact.baileys.name ||
		receipt.baileys.version !== artifact.baileys.version
	) {
		return false;
	}
	const targets = artifact.targets.map((target) => ({
		relativePath: target.relativePath,
		preimageSha256: target.preimageSha256,
		postimageSha256: target.postimageSha256,
	}));
	return JSON.stringify(receipt.targets) === JSON.stringify(targets);
}

function readReceipt(path: string): ManagedBaileysPatchReceipt | null {
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Reflect.get(value, "schemaVersion") !== "clawdi.managedBaileysPatchReceipt.v2" ||
			Reflect.get(value, "patchRevision") !== MANAGED_BAILEYS_PATCH_REVISION ||
			!Reflect.get(value, "artifact")
		) {
			throw new Error("unknown receipt schema or patch revision");
		}
		const receipt = value as ManagedBaileysPatchReceipt;
		if (
			(receipt.artifact.runtime !== "openclaw" && receipt.artifact.runtime !== "hermes") ||
			typeof receipt.artifact.artifactRoot !== "string" ||
			!Array.isArray(receipt.artifact.targets)
		) {
			throw new Error("receipt artifact set is invalid");
		}
		return receipt;
	} catch (error) {
		throw new Error(`managed WhatsApp compatibility receipt is invalid: ${String(error)}`);
	}
}

function directoryEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return false;
		throw error;
	}
}

function sha256File(path: string): string {
	const descriptor = openSync(path, "r");
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		let count = 0;
		do {
			count = readSync(descriptor, buffer, 0, buffer.length, null);
			if (count > 0) hash.update(buffer.subarray(0, count));
		} while (count > 0);
	} finally {
		closeSync(descriptor);
	}
	return hash.digest("hex");
}

function sha256String(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export const MANAGED_BAILEYS_STATIC_PATCH_TARGETS = {
	baileys: BAILEYS_TARGETS,
	openclaw: OPENCLAW_CONSUMER_TARGET,
	hermes: HERMES_CONSUMER_TARGET,
} as const;
