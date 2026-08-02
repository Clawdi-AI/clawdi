import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { egressProfileSchema } from "../src/runtime/egress-profiles";
import { buildManagedWhatsAppEgressProfiles } from "../src/runtime/whatsapp-egress";
import {
	CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER,
	WHATSAPP_LINKING_READY,
	WHATSAPP_RUNTIME_READY,
	WHATSAPP_RUNTIME_REQUIREMENTS,
	WHATSAPP_UPSTREAM_AUDIT,
	WHATSAPP_UPSTREAM_READY,
} from "../src/runtime/whatsapp-upstream-contract";

const agentTokenSecretRef = (link: string) =>
	`secret://channels/whatsapp/account/links/${link}/agent-token`;
const capabilitySecretRef = (link: string) =>
	`secret://channels/whatsapp/account/links/${link}/egress-capability`;

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
			expect(source).not.toMatch(/\bBasePlatformAdapter\b|HERMES_WA_CREDS_JSON|WHATSAPP_MODE/);
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

	it("gates new upgrades on an exact per-Link capability and denies stale markers", () => {
		const profiles = buildManagedWhatsAppEgressProfiles({
			controlPlaneApiUrl: "https://control-plane.test/base?ignored=true",
			links: ["link-a", "link-b"].map((linkId) => ({
				linkId,
				agentTokenSecretRef: agentTokenSecretRef(linkId),
				capabilitySecretRef: capabilitySecretRef(linkId),
				capabilityExpiresAt: "2099-08-01T00:00:00Z",
			})),
		});

		expect(profiles).toHaveLength(3);
		for (const profile of profiles) {
			expect(egressProfileSchema.safeParse(profile).success).toBe(true);
			expect(profile.id).not.toContain("link-a");
			expect(profile.id).not.toContain("link-b");
		}
		const managed = profiles.filter((profile) => profile.kind === "websocket");
		expect(managed).toHaveLength(2);
		expect(
			managed.map((profile) => profile.match.headers[CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER]),
		).toEqual([
			{
				type: "secretRefEquals",
				secretRef: capabilitySecretRef("link-a"),
			},
			{
				type: "secretRefEquals",
				secretRef: capabilitySecretRef("link-b"),
			},
		]);
		for (const profile of managed) {
			expect(profile.match.path).toEqual({ type: "equals", value: "/ws/chat" });
			expect(profile.match.notAfter).toBe("2099-08-01T00:00:00Z");
			expect(profile.rewrite?.upstreamBaseUrl).toBe(
				"wss://control-plane.test/v1/channels/whatsapp/baileys",
			);
			expect(profile.rewrite?.preservePath).toBe(false);
			expect(profile.rewrite?.removeHeaders).toEqual([CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER]);
			expect(profile.rewrite?.upstreamBaseUrl).not.toMatch(/link|account|capability/i);
		}
		expect(profiles.at(-1)).toMatchObject({
			kind: "deny",
			match: {
				headers: {
					[CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER]: { type: "exists" },
				},
			},
		});
		expect(profiles.at(-1)?.match.path).toBeUndefined();
	});

	it("keeps every release, linking, runtime, and drill gate disabled", () => {
		expect(WHATSAPP_LINKING_READY).toBe(false);
		expect(WHATSAPP_RUNTIME_READY).toBe(false);
		expect(WHATSAPP_UPSTREAM_READY).toBe(false);
		expect(Object.values(WHATSAPP_RUNTIME_REQUIREMENTS)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});

	it("pins both rc13 registry artifacts and proves their shared surface has no trust seam", () => {
		const sidecarRoot = join(import.meta.dir, "../../whatsapp-baileys-sidecar");
		const baileysRoot = realpathSync(join(sidecarRoot, "node_modules/baileys"));
		const packageJson = JSON.parse(readFileSync(join(baileysRoot, "package.json"), "utf-8")) as {
			name: string;
			version: string;
		};
		const noiseHandler = readFileSync(join(baileysRoot, "lib/Utils/noise-handler.js"), "utf-8");
		const socketTypes = readFileSync(join(baileysRoot, "lib/Types/Socket.d.ts"), "utf-8");
		const sidecarRuntime = readFileSync(join(sidecarRoot, "src/runtime.ts"), "utf-8");
		const sidecarConfig = readFileSync(join(sidecarRoot, "src/config.ts"), "utf-8");
		const sidecarState = readFileSync(join(sidecarRoot, "src/sqlite-state.ts"), "utf-8");
		const auditedVersion = readFileSync(join(sidecarRoot, "src/audited-version.ts"), "utf-8");
		const lockfile = readFileSync(join(import.meta.dir, "../../../bun.lock"), "utf-8");
		const release = WHATSAPP_UPSTREAM_AUDIT.baileysRelease;
		const openclawArtifact = release.artifacts.openclaw;
		const hermesArtifact = release.artifacts.hermes;

		expect(openclawArtifact.package).toBe("baileys");
		expect(openclawArtifact.consumerStableCommit).toBe("2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4");
		expect(openclawArtifact.npmIntegrity).toBe(
			"sha512-v8k74K8B5R7WNYGa26MyJAYEu3Wc4BSuK01QaK8lr30lhE8Nga31nWNu8KN0NDDt+Fsvkq4SQFFI8Q13ghjKmA==",
		);
		expect(hermesArtifact.package).toBe("@whiskeysockets/baileys");
		expect(hermesArtifact.consumerStableCommit).toBe("cc4cab2f592e60a197e796506de9168f74baf3ea");
		expect(hermesArtifact.npmIntegrity).toBe(
			"sha512-8JPc8gaaCRykkjW2jxLGQ7/RZGrc7awO7WU+QJocf58eSUI9jAdcuYLynzhAbyU4UWvJJsHImZ+5E/JaZj5ypA==",
		);
		expect(openclawArtifact.npmIntegrity).not.toBe(hermesArtifact.npmIntegrity);
		expect(WHATSAPP_UPSTREAM_AUDIT.openclaw).not.toHaveProperty("mainCommit");
		expect(WHATSAPP_UPSTREAM_AUDIT.hermes).not.toHaveProperty("mainCommit");
		expect(packageJson.name).toBe(hermesArtifact.package);
		expect(packageJson.version).toBe(release.version);
		expect(release.gitCommit).toBe("8053b086ecc97ec3f78299561de11959bab05d39");
		expect(lockfile).toContain(hermesArtifact.npmIntegrity);
		expect(lockfile).not.toContain(openclawArtifact.npmIntegrity);
		expect(createHash("sha256").update(noiseHandler).digest("hex")).toBe(
			release.sharedSurfaceSha256.noiseHandler,
		);
		expect(createHash("sha256").update(socketTypes).digest("hex")).toBe(
			release.sharedSurfaceSha256.socketTypes,
		);
		expect(noiseHandler).toContain(
			"Curve.verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details",
		);
		expect(noiseHandler).toContain("issuerSerial !== WA_CERT_DETAILS.SERIAL");
		expect(socketTypes).not.toMatch(/\bauthCert\s*[?:]/);
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
		expect(sidecarState).toContain('["account_id", input.accountId]');
		expect(sidecarState).not.toMatch(/process\.kill|unlinkSync/);
		expect(auditedVersion).toContain('AUDITED_BAILEYS_RELEASE = "7.0.0-rc13"');
		expect(auditedVersion).toContain('AUDITED_WHATSAPP_WEB_VERSION_TEXT = "2.3000.1035194821"');
		expect(release.noiseTrustSeam.available).toBe(false);
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
