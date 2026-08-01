import { describe, expect, it } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
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
	it("routes only an exact per-Link capability and denies stale managed markers", () => {
		const profiles = buildManagedWhatsAppEgressProfiles({
			cloudApiUrl: "https://cloud-api.test/base?ignored=true",
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
				"wss://cloud-api.test/v1/channels/whatsapp/baileys",
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

	it("pins rc13 and proves stock Baileys has no Noise authCert seam", () => {
		const sidecarRoot = join(import.meta.dir, "../../whatsapp-baileys-sidecar");
		const baileysRoot = realpathSync(join(sidecarRoot, "node_modules/baileys"));
		const packageJson = JSON.parse(readFileSync(join(baileysRoot, "package.json"), "utf-8")) as {
			name: string;
			version: string;
		};
		const noiseHandler = readFileSync(join(baileysRoot, "lib/Utils/noise-handler.js"), "utf-8");
		const socketTypes = readFileSync(join(baileysRoot, "lib/Types/Socket.d.ts"), "utf-8");
		const sidecarRuntime = readFileSync(join(sidecarRoot, "src/runtime.ts"), "utf-8");
		const lockfile = readFileSync(join(import.meta.dir, "../../../bun.lock"), "utf-8");

		expect(packageJson.name).toBe(WHATSAPP_UPSTREAM_AUDIT.baileys.package);
		expect(packageJson.version).toBe(WHATSAPP_UPSTREAM_AUDIT.baileys.version);
		expect(WHATSAPP_UPSTREAM_AUDIT.baileys.gitCommit).toBe(
			"8053b086ecc97ec3f78299561de11959bab05d39",
		);
		expect(lockfile).toContain(WHATSAPP_UPSTREAM_AUDIT.baileys.npmIntegrity);
		expect(noiseHandler).toContain(
			"Curve.verify(WA_CERT_DETAILS.PUBLIC_KEY, certIntermediate.details",
		);
		expect(noiseHandler).toContain("issuerSerial !== WA_CERT_DETAILS.SERIAL");
		expect(socketTypes).not.toMatch(/\bauthCert\s*[?:]/);
		expect(sidecarRuntime).not.toContain("authCert");
		expect(WHATSAPP_UPSTREAM_AUDIT.baileys.noiseTrustSeam.available).toBe(false);
	});
});
