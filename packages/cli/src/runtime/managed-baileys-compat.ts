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
import { isValidSemver } from "../lib/semver";
import type { RuntimePaths } from "./paths";
import { makeRuntimeUserOwned, spawnRuntimeUserCommand } from "./runtime-user-command";

export const MANAGED_BAILEYS_PATCH_REVISION = "clawdi.managedBaileysCompat.v2";

const BAILEYS_COMPATIBLE_MAJOR = 7;
const RECEIPT_FILE = "managed-baileys-compat.json";
const RECEIPT_SCHEMA = "clawdi.managedBaileysPatchReceipt.v3";

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

interface ManagedBaileysArtifact {
	runtime: ManagedBaileysRuntime;
	root: string;
	packageName: "baileys" | "@whiskeysockets/baileys";
	targets: readonly StaticPatchTarget[];
	hermesBridgeRoot?: string;
}

export interface ManagedBaileysPatchReceiptTarget {
	relativePath: string;
	preimageSha256: string;
	postimageSha256: string;
}

export interface ManagedBaileysPatchReceiptArtifact {
	runtime: ManagedBaileysRuntime;
	artifactRoot: string;
	baileys: {
		name: string;
		observedVersion: string;
		compatibleMajor: typeof BAILEYS_COMPATIBLE_MAJOR;
	};
	targets: ManagedBaileysPatchReceiptTarget[];
}

export interface ManagedBaileysPatchReceipt {
	schemaVersion: typeof RECEIPT_SCHEMA;
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
		relativePath: "lib/Socket/socket.js",
		preimageSha256: "ab9b68888e123ad683dbc26555fc928400c1526c93ec6b66853f2ba30f8177a9",
		postimageSha256: "3e4ce87fc485635c9ada35cc4056110136356fcb3b549955a7518943d45082c0",
		replacements: [
			{
				before: "import { executeWMexQuery } from './mex.js';\n",
				after:
					"import { executeWMexQuery } from './mex.js';\n" +
					"const CLAWDI_MANAGED_SOCKET_KEY = 'clawdi.managedWhatsAppSocket';\n" +
					"const CLAWDI_MANAGED_SOCKET_SCHEMA = 'clawdi.managedWhatsAppSocket.v1';\n" +
					"const CLAWDI_LINK_CAPABILITY_HEADER = 'x-clawdi-whatsapp-link-capability';\n" +
					"const OFFICIAL_WHATSAPP_WEB_SOCKET_URL = 'wss://web.whatsapp.com/ws/chat';\n" +
					"const hasExactKeys = (value, keys) => Object.keys(value).sort().join('\\0') === [...keys].sort().join('\\0');\n" +
					"const managedSocketMetadata = (creds) => {\n" +
					"    const additionalData = creds?.additionalData;\n" +
					"    if (!additionalData || typeof additionalData !== 'object' || Array.isArray(additionalData) || !Object.prototype.hasOwnProperty.call(additionalData, CLAWDI_MANAGED_SOCKET_KEY)) {\n" +
					"        return undefined;\n" +
					"    }\n" +
					"    const value = additionalData[CLAWDI_MANAGED_SOCKET_KEY];\n" +
					"    const authCert = value?.authCert;\n" +
					"    if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactKeys(value, ['authCert', 'capability', 'schemaVersion']) || value.schemaVersion !== CLAWDI_MANAGED_SOCKET_SCHEMA || typeof value.capability !== 'string' || !/^clawdi_[a-f0-9]{32}$/.test(value.capability) || !authCert || typeof authCert !== 'object' || Array.isArray(authCert) || !hasExactKeys(authCert, ['ISSUER', 'PUBLIC_KEY', 'SERIAL']) || !Number.isSafeInteger(authCert.SERIAL) || authCert.SERIAL < 0 || typeof authCert.ISSUER !== 'string' || !authCert.ISSUER || authCert.ISSUER.trim() !== authCert.ISSUER || authCert.ISSUER.length > 256 || !Buffer.isBuffer(authCert.PUBLIC_KEY) || authCert.PUBLIC_KEY.length !== 32) {\n" +
					"        throw new Error('Invalid Clawdi managed WhatsApp socket metadata');\n" +
					"    }\n" +
					"    return value;\n" +
					"};\n",
			},
			{
				before:
					"    const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config;\n",
				after:
					"    const { waWebSocketUrl, connectTimeoutMs, logger, keepAliveIntervalMs, browser, auth: authState, printQRInTerminal, defaultQueryTimeoutMs, transactionOpts, qrTimeout, makeSignalRepository } = config;\n" +
					"    const managedMetadata = managedSocketMetadata(authState?.creds);\n",
			},
			{
				before:
					"    const url = typeof waWebSocketUrl === 'string' ? new URL(waWebSocketUrl) : waWebSocketUrl;\n",
				after:
					"    const effectiveWebSocketUrl = managedMetadata ? OFFICIAL_WHATSAPP_WEB_SOCKET_URL : waWebSocketUrl;\n" +
					"    const url = typeof effectiveWebSocketUrl === 'string' ? new URL(effectiveWebSocketUrl) : effectiveWebSocketUrl;\n",
			},
			{
				before: "        routingInfo: authState?.creds?.routingInfo\n",
				after:
					"        routingInfo: authState?.creds?.routingInfo,\n" +
					"        authCert: managedMetadata?.authCert\n",
			},
			{
				before: "    const ws = new WebSocketClient(url, config);\n",
				after:
					"    const webSocketConfig = managedMetadata ? {\n" +
					"        ...config,\n" +
					"        options: {\n" +
					"            ...config.options,\n" +
					"            headers: {\n" +
					"                ...config.options?.headers,\n" +
					"                [CLAWDI_LINK_CAPABILITY_HEADER]: managedMetadata.capability\n" +
					"            }\n" +
					"        }\n" +
					"    } : config;\n" +
					"    const ws = new WebSocketClient(url, webSocketConfig);\n",
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
		postimageSha256: "34197090723b4b197b36062d8283f86ada1f8d5863a58efab446b8bf87f2e28e",
		replacements: [
			{
				before:
					"export declare const makeNoiseHandler: ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo }: {\n",
				after:
					"export declare const makeNoiseHandler: ({ keyPair: { private: privateKey, public: publicKey }, NOISE_HEADER, logger, routingInfo, authCert }: {\n",
			},
			{
				before: "    routingInfo?: Buffer | undefined;\n",
				after:
					"    routingInfo?: Buffer | undefined;\n" +
					"    authCert?: {\n" +
					"        SERIAL: number;\n" +
					"        ISSUER: string;\n" +
					"        PUBLIC_KEY: Uint8Array;\n" +
					"    };\n",
			},
		],
	},
] as const satisfies readonly StaticPatchTarget[];

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
	if (input.runtime === "hermes" && !existsSync(join(artifact.root, "package.json"))) {
		return [join(assertHermesBridgeRoot(artifact), "node_modules")];
	}
	const targets = artifact.targets.map((target) => join(artifact.root, target.relativePath));
	if (input.runtime === "hermes") {
		targets.push(join(assertHermesBridgeRoot(artifact), "node_modules", ".hermes-pkg-hash"));
	}
	return targets;
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
	if (!input.desiredRuntime) return rollbackManagedBaileysCompatibility(receiptPath, input.home);
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
	const observedVersion = verifyArtifactIdentity(artifact);
	const targetStates = artifact.targets.map((target) => classifyTarget(artifact, target));
	const unknown = targetStates.filter((state) => state.state === "unknown");
	if (unknown.length > 0) {
		throw new Error(
			`managed WhatsApp compatibility patch refused drifted ${artifact.runtime} artifacts: ${unknown
				.map((state) => `${state.path} (${state.sha256})`)
				.join(", ")}`,
		);
	}

	let existingReceipt = readReceipt(receiptPath);
	if (existingReceipt && !receiptLayoutMatches(existingReceipt.artifact, artifact)) {
		const rollback = rollbackManagedBaileysCompatibility(receiptPath, input.home);
		if (rollback.status === "rollback-refused") {
			throw new Error(
				`managed WhatsApp compatibility could not recover the previous artifact: ${rollback.errors.join(", ")}`,
			);
		}
		existingReceipt = null;
	}

	const receipt = buildReceipt(artifact, observedVersion);
	const receiptMatches = existingReceipt ? receiptsEqual(existingReceipt, receipt) : false;
	const requiresPatch = targetStates.some((state) => state.state === "preimage");
	if (requiresPatch || !receiptMatches) writeReceiptDurable(receiptPath, receipt);
	if (requiresPatch) applyArtifactTargets(artifact, targetStates);
	if (artifact.runtime === "hermes") writeHermesDependencyStamp(assertHermesBridgeRoot(artifact));
	return {
		status: requiresPatch ? "applied" : receiptMatches ? "already-patched" : "receipt-recovered",
		receiptPath,
	};
}

function rollbackManagedBaileysCompatibility(
	receiptPath: string,
	home: string,
): ManagedBaileysReconcileResult {
	const receipt = readReceipt(receiptPath);
	if (!receipt) return { status: "inert", receiptPath };
	const artifact = resolveInstalledArtifact(receipt.artifact.runtime, home);
	const errors: string[] = [];
	if (!receiptLayoutMatches(receipt.artifact, artifact)) {
		errors.push("managed WhatsApp compatibility receipt does not match the audited artifact");
	} else if (directoryEntryExists(artifact.root)) {
		try {
			verifyArtifactIdentity(artifact);
		} catch (error) {
			errors.push(String(error));
		}
		const rollbackEntries: Array<{ path: string; expectedSha256: string; content: string }> = [];
		const auditedStates: Array<{ path: string; expectedSha256: string }> = [];
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
		if (errors.length > 0) return { status: "rollback-refused", receiptPath, errors };
		replaceTargetContents(rollbackEntries, auditedStates);
	}
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
		const expectedAppRoot = join(input.home, ".openclaw");
		if (resolve(input.appRoot) !== resolve(expectedAppRoot)) {
			throw new Error(`managed WhatsApp OpenClaw app root must be ${expectedAppRoot}`);
		}
		return resolveInstalledArtifact("openclaw", input.home);
	}
	const expectedAppRoot = join(input.home, ".hermes", "hermes-agent");
	if (resolve(input.appRoot) !== resolve(expectedAppRoot)) {
		throw new Error(`managed WhatsApp Hermes app root must be ${expectedAppRoot}`);
	}
	return resolveInstalledArtifact("hermes", input.home);
}

function resolveInstalledArtifact(
	runtime: ManagedBaileysRuntime,
	home: string,
): ManagedBaileysArtifact {
	if (runtime === "openclaw") {
		return {
			runtime,
			root: join(home, ".openclaw", "extensions", "whatsapp", "node_modules", "baileys"),
			packageName: "baileys",
			targets: BAILEYS_TARGETS,
		};
	}
	const hermesBridgeRoot = join(home, ".hermes", "hermes-agent", "scripts", "whatsapp-bridge");
	return {
		runtime,
		root: join(hermesBridgeRoot, "node_modules", "@whiskeysockets", "baileys"),
		packageName: "@whiskeysockets/baileys",
		targets: BAILEYS_TARGETS,
		hermesBridgeRoot,
	};
}

function assertHermesBridgeRoot(artifact: ManagedBaileysArtifact): string {
	if (!artifact.hermesBridgeRoot) throw new Error("managed WhatsApp Hermes bridge root is missing");
	return artifact.hermesBridgeRoot;
}

function verifyArtifactIdentity(artifact: ManagedBaileysArtifact): string {
	assertTrustedRealDirectory(artifact.root);
	const packagePath = join(artifact.root, "package.json");
	assertTrustedRealFile(artifact.root, packagePath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(packagePath, "utf8"));
	} catch (error) {
		throw new Error(
			`managed WhatsApp compatibility could not read ${packagePath}: ${String(error)}`,
		);
	}
	const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	const name = record ? Reflect.get(record, "name") : null;
	const version = record ? Reflect.get(record, "version") : null;
	if (name !== artifact.packageName) {
		throw new Error(
			`managed WhatsApp compatibility requires package ${artifact.packageName}; found ${String(name)}`,
		);
	}
	if (typeof version !== "string" || !isValidSemver(version) || !version.startsWith("7.")) {
		throw new Error(
			`managed WhatsApp compatibility requires valid Baileys SemVer major 7; found ${String(version)}`,
		);
	}
	return version;
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
	const staged: Array<(typeof entries)[number] & { stagingPath: string }> = [];
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

function buildReceipt(
	artifact: ManagedBaileysArtifact,
	observedVersion: string,
): ManagedBaileysPatchReceipt {
	return {
		schemaVersion: RECEIPT_SCHEMA,
		patchRevision: MANAGED_BAILEYS_PATCH_REVISION,
		artifact: {
			runtime: artifact.runtime,
			artifactRoot: artifact.root,
			baileys: {
				name: artifact.packageName,
				observedVersion,
				compatibleMajor: BAILEYS_COMPATIBLE_MAJOR,
			},
			targets: artifact.targets.map(({ relativePath, preimageSha256, postimageSha256 }) => ({
				relativePath,
				preimageSha256,
				postimageSha256,
			})),
		},
	};
}

function receiptLayoutMatches(
	receipt: ManagedBaileysPatchReceiptArtifact | undefined,
	artifact: ManagedBaileysArtifact,
): boolean {
	if (
		!receipt ||
		receipt.runtime !== artifact.runtime ||
		receipt.artifactRoot !== artifact.root ||
		receipt.baileys.name !== artifact.packageName ||
		receipt.baileys.compatibleMajor !== BAILEYS_COMPATIBLE_MAJOR
	) {
		return false;
	}
	const targets = artifact.targets.map(({ relativePath, preimageSha256, postimageSha256 }) => ({
		relativePath,
		preimageSha256,
		postimageSha256,
	}));
	return JSON.stringify(receipt.targets) === JSON.stringify(targets);
}

function receiptsEqual(
	left: ManagedBaileysPatchReceipt,
	right: ManagedBaileysPatchReceipt,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function readReceipt(path: string): ManagedBaileysPatchReceipt | null {
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Reflect.get(value, "schemaVersion") !== RECEIPT_SCHEMA ||
			Reflect.get(value, "patchRevision") !== MANAGED_BAILEYS_PATCH_REVISION
		) {
			throw new Error("unknown receipt schema or patch revision");
		}
		const receipt = value as ManagedBaileysPatchReceipt;
		const artifact = receipt.artifact;
		if (
			!artifact ||
			(artifact.runtime !== "openclaw" && artifact.runtime !== "hermes") ||
			typeof artifact.artifactRoot !== "string" ||
			typeof artifact.baileys?.name !== "string" ||
			typeof artifact.baileys.observedVersion !== "string" ||
			artifact.baileys.compatibleMajor !== BAILEYS_COMPATIBLE_MAJOR ||
			!Array.isArray(artifact.targets) ||
			artifact.targets.some(
				(target) =>
					typeof target.relativePath !== "string" ||
					typeof target.preimageSha256 !== "string" ||
					typeof target.postimageSha256 !== "string",
			)
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

export const MANAGED_BAILEYS_STATIC_PATCH_TARGETS = BAILEYS_TARGETS;
