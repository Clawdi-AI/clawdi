import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

describe("native WhatsApp egress contract", () => {
	it("keeps one physical socket implementation and no legacy application connector", () => {
		const repositoryRoot = realpathSync(join(import.meta.dir, "../../.."));
		const productionRoots = [
			join(repositoryRoot, "backend/app"),
			join(repositoryRoot, "packages/cli/src"),
			join(repositoryRoot, "packages/whatsapp-baileys-sidecar/src"),
		];
		const productionSources = productionRoots.flatMap((root) => sourceFiles(root));
		const socketOwners = productionSources.filter((path) =>
			readFileSync(path, "utf-8").includes("makeWASocket("),
		);

		expect(socketOwners).toEqual([
			join(repositoryRoot, "packages/whatsapp-baileys-sidecar/src/runtime.ts"),
		]);
		expect(
			existsSync(join(repositoryRoot, "backend/app/services/whatsapp_shared_runtime.py")),
		).toBe(false);
		expect(
			existsSync(join(repositoryRoot, "backend/app/services/whatsapp_media_reupload.py")),
		).toBe(false);
		for (const path of productionSources) {
			const source = readFileSync(path, "utf-8");
			expect(source).not.toMatch(/\bBasePlatformAdapter\b|HERMES_WA_CREDS_JSON/);
		}
	});

	it("contains no Meta Cloud or Graph compatibility in production WhatsApp modules", () => {
		const repositoryRoot = realpathSync(join(import.meta.dir, "../../.."));
		const whatsappSources = [
			...sourceFiles(join(repositoryRoot, "backend/app")),
			...sourceFiles(join(repositoryRoot, "packages/cli/src")),
			...sourceFiles(join(repositoryRoot, "packages/whatsapp-baileys-sidecar/src")),
		].filter((path) => path.slice(repositoryRoot.length).toLowerCase().includes("whatsapp"));

		for (const path of whatsappSources) {
			const source = readFileSync(path, "utf-8");
			expect(source).not.toMatch(
				/graph\.facebook|WHATSAPP_GRAPH|graph_api|\bMeta (?:Cloud|Graph)\b|\bCloud API\b|media.?reupload/i,
			);
		}
		const routeSource = readFileSync(
			join(repositoryRoot, "backend/app/routes/channel_routers/whatsapp.py"),
			"utf-8",
		);
		expect(routeSource).not.toMatch(/\/graph|\/webhook|\/media/);
	});

	it("qualifies the pinned rc14 physical sidecar artifact", () => {
		const sidecarRoot = join(import.meta.dir, "../../whatsapp-baileys-sidecar");
		const baileysRoot = realpathSync(join(sidecarRoot, "node_modules/baileys"));
		const packageJson = JSON.parse(readFileSync(join(baileysRoot, "package.json"), "utf-8")) as {
			name: string;
			version: string;
		};
		const noiseHandler = readFileSync(join(baileysRoot, "lib/Utils/noise-handler.js"), "utf-8");
		const socket = readFileSync(join(baileysRoot, "lib/Socket/socket.js"), "utf-8");
		const noiseTypes = readFileSync(join(baileysRoot, "lib/Utils/noise-handler.d.ts"), "utf-8");
		const sidecarRuntime = readFileSync(join(sidecarRoot, "src/runtime.ts"), "utf-8");
		const sidecarConfig = readFileSync(join(sidecarRoot, "src/config.ts"), "utf-8");
		const sidecarState = readFileSync(join(sidecarRoot, "src/sqlite-state.ts"), "utf-8");
		const auditedVersion = readFileSync(join(sidecarRoot, "src/audited-version.ts"), "utf-8");
		expect(packageJson.name).toBe("@whiskeysockets/baileys");
		expect(packageJson.version).toBe("7.0.0-rc14");
		expect(createHash("sha256").update(noiseHandler).digest("hex")).toBe(
			"970f9526ce0e5a6bebf937328b3d835966a9282c0d232f31b5c0bb283531afe8",
		);
		expect(createHash("sha256").update(socket).digest("hex")).toBe(
			"ff8b19ff02491fa080ee371f066d49c94acb903207dd0d9fdb5548e5a594fb4a",
		);
		expect(createHash("sha256").update(noiseTypes).digest("hex")).toBe(
			"a556ca0b67c3448769ad5ed0d59acbf566a21115fa107cd582b1dcb28c4fd516",
		);
		expect(noiseHandler).toContain(
			"Curve.verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details",
		);
		expect(noiseHandler).toContain("issuerSerial !== WA_CERT_DETAILS.SERIAL");
		expect(socket).not.toContain("clawdi.managedWhatsAppSocket");
		expect(noiseTypes).not.toMatch(/\bauthCert\s*[?:]/);
		expect(sidecarRuntime).not.toContain("authCert");
		expect(sidecarRuntime).not.toContain("waWebSocketUrl");
		expect(sidecarConfig).not.toContain("CLAWDI_WA_WEBSOCKET_URL");
		expect(sidecarRuntime.match(/makeWASocket\(/g)).toHaveLength(1);
		expect(sidecarRuntime).toContain("new SQLiteProviderState(");
		expect(sidecarRuntime).not.toContain("useMultiFileAuthState");
		expect(sidecarRuntime).not.toContain("fetchLatestBaileysVersion");
		expect(sidecarState).toContain('db.exec("PRAGMA journal_mode = WAL")');
		expect(sidecarState).toContain('db.exec("PRAGMA synchronous = FULL")');
		expect(sidecarState).toContain('db.exec("PRAGMA locking_mode = EXCLUSIVE")');
		expect(sidecarState).toContain('["account_id", input.sessionId]');
		expect(sidecarState).not.toMatch(/process\.kill|unlinkSync/);
		expect(auditedVersion).toContain('AUDITED_BAILEYS_RELEASE = "7.0.0-rc14"');
		expect(auditedVersion).toContain(
			'AUDITED_BAILEYS_SOURCE_COMMIT = "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a"',
		);
		expect(auditedVersion).toContain('AUDITED_WHATSAPP_WEB_VERSION_TEXT = "2.3000.1043857760"');
	});
});

function sourceFiles(root: string): string[] {
	return readdirSync(root)
		.flatMap((name) => {
			const path = join(root, name);
			return statSync(path).isDirectory() ? sourceFiles(path) : [path];
		})
		.filter((path) => /\.(?:js|py|ts)$/.test(path));
}
