import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const deploy = readFileSync(resolve(repoRoot, "config/deploy.yml"), "utf8");
const workflow = readFileSync(
	resolve(repoRoot, ".github/workflows/clawdi-image-release.yml"),
	"utf8",
);
const dockerfile = readFileSync(
	resolve(repoRoot, "packages/whatsapp-baileys-sidecar/Dockerfile"),
	"utf8",
);

describe("WhatsApp sidecar production deployment contract", () => {
	test("uses one fixed business-neutral accessory and a clean session state root", () => {
		expect(deploy.match(/^ {2}whatsapp-baileys:$/gm)).toHaveLength(1);
		expect(deploy).toContain("service: clawdi-whatsapp-baileys");
		expect(deploy).toContain("network: bridge");
		expect(deploy).toContain("/home/phala/clawdi-whatsapp/state");
		expect(deploy).toContain("/home/phala/clawdi-whatsapp/run");
		expect(deploy).toContain("CLAWDI_WA_SIDECAR_STATE_ROOT: /data");
		expect(deploy).toContain("CLAWDI_WA_SIDECAR_SOCKET_PATH: /run/clawdi-whatsapp/sidecar.sock");
		expect(deploy).toContain("CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN");
		expect(deploy).not.toContain("whatsapp_accounts");
	});

	test("health-checks the singleton before deploying the backend", () => {
		const reboot = workflow.indexOf("kamal accessory reboot whatsapp-baileys");
		const health = workflow.indexOf("dist/healthcheck.js", reboot);
		const appDeploy = workflow.indexOf(
			`kamal deploy -P --version "\${{ needs.build.outputs.image_tag }}"`,
		);

		expect(reboot).toBeGreaterThan(0);
		expect(health).toBeGreaterThan(reboot);
		expect(appDeploy).toBeGreaterThan(health);
		expect(workflow).toContain("Build and push WhatsApp sidecar image");
		expect(workflow).toContain(
			`ghcr.io/clawdi-ai/clawdi-whatsapp-baileys-sidecar:\${{ needs.build.outputs.image_tag }}`,
		);
		expect(workflow).toContain("kamal accessory directories whatsapp-baileys");
		expect(workflow).toContain("docker container inspect --format '{{.Config.Image}}'");
	});

	test("keeps state private and exposes only a read-only Unix socket to the app", () => {
		expect(deploy).toContain("/home/phala/clawdi-whatsapp/run:/run/clawdi-whatsapp:ro");
		expect(deploy).toContain('remote: /data\n        mode: "700"');
		expect(deploy).toContain('remote: /run/clawdi-whatsapp\n        mode: "770"');
		expect(deploy).toContain("read-only: true");
		expect(deploy).toContain(
			"memory: 2g # bounded headroom for multiple isolated provider sessions",
		);
		expect(deploy).toContain("ulimit: nofile=65536:65536");
		expect(deploy).toContain("cap-drop: ALL");
		expect(deploy).toContain("security-opt: no-new-privileges:true");
	});

	test("builds with the repository toolchain and runs on non-root Node", () => {
		expect(dockerfile).toContain("FROM oven/bun:1.3.14-alpine");
		expect(dockerfile).toContain("bun install --frozen-lockfile --production");
		expect(dockerfile).toContain("FROM node:24.18.0-alpine AS runtime");
		expect(dockerfile).toContain("USER node:node");
		expect(dockerfile).toContain(
			'CMD ["node", "/app/packages/whatsapp-baileys-sidecar/dist/index.js"]',
		);
		expect(dockerfile).toContain("HEALTHCHECK");
		expect(dockerfile).not.toContain("latest");
	});
});
