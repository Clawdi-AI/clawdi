import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { prepareWhatsAppSidecarDeploy } from "../../../scripts/prepare-whatsapp-sidecar-deploy";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_TOKEN = "A".repeat(64);
const SECOND_TOKEN = "B".repeat(64);
const repoRoot = resolve(import.meta.dir, "../../..");
const sidecarDockerfile = readFileSync(
	join(repoRoot, "packages/whatsapp-baileys-sidecar/Dockerfile"),
	"utf8",
);
const deployConfig = readFileSync(join(repoRoot, "config/deploy.yml"), "utf8");
const imageWorkflow = readFileSync(
	join(repoRoot, ".github/workflows/clawdi-image-release.yml"),
	"utf8",
);
const backendWorkflow = readFileSync(join(repoRoot, ".github/workflows/backend-ci.yml"), "utf8");
const materializerSource = readFileSync(
	join(repoRoot, "scripts/prepare-whatsapp-sidecar-deploy.ts"),
	"utf8",
);
const dockerignore = readFileSync(join(repoRoot, ".dockerignore"), "utf8");

describe("WhatsApp sidecar deployment materializer", () => {
	test("derives sorted disjoint accounts and keeps tokens out of the manifest", () => {
		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			writeFileSync(secretsPath, "BASE_SECRET=preserved\n", { mode: 0o600 });
			const rawRegistry = JSON.stringify({
				[SECOND_ID]: entry(SECOND_ID, SECOND_TOKEN),
				[FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN),
			});

			const manifest = prepareWhatsAppSidecarDeploy({ rawRegistry, manifestPath, secretsPath });

			expect(manifest.accounts.map((account) => account.account_id)).toEqual([FIRST_ID, SECOND_ID]);
			expect(new Set(manifest.accounts.map((account) => account.accessory_name)).size).toBe(2);
			expect(new Set(manifest.accounts.map((account) => account.socket_path)).size).toBe(2);
			const publicManifest = readFileSync(manifestPath, "utf8");
			expect(publicManifest).not.toContain(FIRST_TOKEN);
			expect(publicManifest).not.toContain(SECOND_TOKEN);
			expect(publicManifest).toContain(`/run/clawdi-whatsapp/${FIRST_ID}/sidecar.sock`);
			const secrets = readFileSync(secretsPath, "utf8");
			expect(secrets).toContain("BASE_SECRET=preserved");
			expect(secrets).toContain("CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON=");
			expect(secrets).toContain(SECOND_TOKEN);
			expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
			expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
		});
	});

	test("replaces its generated secret block without retaining rotated tokens", () => {
		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			writeFileSync(secretsPath, "BASE_SECRET=preserved\n", { mode: 0o600 });
			prepareWhatsAppSidecarDeploy({
				rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN) }),
				manifestPath,
				secretsPath,
			});
			prepareWhatsAppSidecarDeploy({
				rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, SECOND_TOKEN) }),
				manifestPath,
				secretsPath,
			});

			const secrets = readFileSync(secretsPath, "utf8");
			expect(secrets).not.toContain(FIRST_TOKEN);
			expect(secrets).toContain(SECOND_TOKEN);
			expect(secrets.match(/BEGIN CLAWDI GENERATED/g)).toHaveLength(1);
			expect(secrets.match(/END CLAWDI GENERATED/g)).toHaveLength(1);
		});
	});

	test("fails closed on non-UDS, unstable, or duplicate secret authority", () => {
		expect(materializerSource).not.toContain('process.env[REGISTRY_KEY] ?? "{}"');

		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			expect(() =>
				prepareWhatsAppSidecarDeploy({ rawRegistry: "", manifestPath, secretsPath }),
			).toThrow("must be valid JSON");
		});

		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			writeFileSync(secretsPath, "unsafe\n", { mode: 0o600 });
			chmodSync(secretsPath, 0o644);
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN) }),
					manifestPath,
					secretsPath,
				}),
			).toThrow("owned mode-600 regular file");
		});

		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			writeFileSync(secretsPath, "CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON=duplicate\n", {
				mode: 0o600,
			});
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({ [FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN) }),
					manifestPath,
					secretsPath,
				}),
			).toThrow("supplied only through the generated sidecar secret block");
		});

		withDeploymentFiles(({ manifestPath, secretsPath }) => {
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({
						[FIRST_ID]: { api_token: FIRST_TOKEN, base_url: "https://sidecar.test" },
					}),
					manifestPath,
					secretsPath,
				}),
			).toThrow("unknown fields");
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({
						[FIRST_ID]: {
							...entry(FIRST_ID, FIRST_TOKEN),
							unix_socket_path: "/run/clawdi-whatsapp/other/sidecar.sock",
						},
					}),
					manifestPath,
					secretsPath,
				}),
			).toThrow("stable account-scoped socket path");
			expect(() =>
				prepareWhatsAppSidecarDeploy({
					rawRegistry: JSON.stringify({
						[FIRST_ID]: entry(FIRST_ID, FIRST_TOKEN),
						[SECOND_ID]: entry(SECOND_ID, FIRST_TOKEN),
					}),
					manifestPath,
					secretsPath,
				}),
			).toThrow("api_token values must be unique");
		});
	});
});

describe("WhatsApp sidecar production deployment contract", () => {
	test("builds an immutable non-root image from the declared Bun toolchain", () => {
		expect(sidecarDockerfile.match(/FROM oven\/bun:1\.3\.14-alpine/g)).toHaveLength(2);
		expect(sidecarDockerfile).toContain(
			"bun install --frozen-lockfile --production --filter @clawdi/whatsapp-baileys-sidecar",
		);
		expect(sidecarDockerfile).toContain("USER bun:bun");
		expect(sidecarDockerfile).toContain("RUN chmod -R a-w /app");
		expect(sidecarDockerfile).toContain("HEALTHCHECK --interval=10s");
		expect(sidecarDockerfile).toContain("src/healthcheck.ts");
		expect(sidecarDockerfile).not.toContain("EXPOSE");
		expect(dockerignore).toContain("packages/whatsapp-baileys-sidecar/src/*.test.ts");
		expect(backendWorkflow).toContain("Build production sidecar image");
		expect(backendWorkflow).toContain("packages/whatsapp-baileys-sidecar/Dockerfile");
	});

	test("uses one Kamal accessory and two disjoint durable host paths per account", () => {
		expect(deployConfig).toContain("whatsapp_accounts.each do |account|");
		expect(deployConfig).toContain("clawdi-whatsapp-baileys-sidecar:<%= sidecar_image_version %>");
		expect(deployConfig).toContain('/<%= account.fetch("account_id") %>/state');
		expect(deployConfig).toContain('/<%= account.fetch("account_id") %>/run');
		expect(deployConfig).toContain('mode: "700"');
		expect(deployConfig).toContain('mode: "770"');
		expect(deployConfig).not.toContain("owner:");
		expect(deployConfig).not.toContain("group-add:");
		expect(deployConfig).toContain(":ro");
		expect(deployConfig).toContain("read-only: true");
		expect(deployConfig).toContain("cap-drop: ALL");
		expect(deployConfig).toContain("CLAWDI_WA_SIDECAR_SOCKET_PATH");
		expect(deployConfig).not.toContain("CLAWDI_WA_SIDECAR_HOST:");
		expect(deployConfig).toContain("network: bridge");
		expect(deployConfig).not.toContain("network: kamal");
	});

	test("builds exact-SHA sidecars and explicitly performs stop-start reconciliation", () => {
		expect(backendWorkflow).toContain('"packages/whatsapp-baileys-sidecar/**"');
		expect(imageWorkflow).toContain("Build and push WhatsApp sidecar image");
		expect(imageWorkflow).toContain(
			"tags: $" + "{{ env.SIDECAR_IMAGE_NAME }}:$" + "{{ steps.rev.outputs.sha }}",
		);
		expect(imageWorkflow).toContain(
			"CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON: $" +
				"{{ secrets.CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON }}",
		);
		const appDeploy = imageWorkflow.indexOf(
			'kamal deploy -P --version "$' + '{{ needs.build.outputs.image_tag }}"',
		);
		const directoryPrepare = imageWorkflow.indexOf('kamal accessory directories "$accessory"');
		const accessoryReboot = imageWorkflow.indexOf('kamal accessory reboot "$accessory"');
		expect(directoryPrepare).toBeGreaterThan(0);
		expect(directoryPrepare).toBeLessThan(appDeploy);
		expect(imageWorkflow).toContain("realpath -e '$" + "{state_path}'");
		expect(imageWorkflow).toContain("1000:1000:700");
		expect(imageWorkflow).toContain("1000:1000:770");
		expect(appDeploy).toBeGreaterThan(0);
		expect(accessoryReboot).toBeGreaterThan(appDeploy);
		expect(imageWorkflow).toContain("src/healthcheck.ts");
		expect(imageWorkflow).not.toContain("kamal accessory remove");
	});

	test("keeps deploy materialization narrow and free of cross-channel or UI behavior", () => {
		for (const forbidden of ["telegram", "discord", "clawdi-hosted"]) {
			expect(materializerSource.toLowerCase()).not.toContain(forbidden);
			expect(sidecarDockerfile.toLowerCase()).not.toContain(forbidden);
		}
		expect(materializerSource).not.toContain("apps/web");
		expect(sidecarDockerfile.match(/COPY apps\/web\/package\.json/g)).toHaveLength(1);
		expect(sidecarDockerfile).not.toContain("COPY --from=dependencies /app/apps/web");
	});
});

function entry(accountId: string, apiToken: string) {
	return {
		api_token: apiToken,
		unix_socket_path: `/run/clawdi-whatsapp/${accountId}/sidecar.sock`,
	};
}

function withDeploymentFiles(
	action: (paths: { manifestPath: string; secretsPath: string }) => void,
): void {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-sidecar-deploy-"));
	chmodSync(directory, 0o700);
	try {
		action({
			manifestPath: resolve(directory, "whatsapp-sidecars.json"),
			secretsPath: resolve(directory, "secrets"),
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
