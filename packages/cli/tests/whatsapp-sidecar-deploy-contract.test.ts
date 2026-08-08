import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	calculateWhatsAppSidecarDeploymentRevision,
	sidecarDependencyClosure,
} from "../../../scripts/whatsapp-sidecar-deployment-revision";

const repoRoot = resolve(import.meta.dir, "../../..");
const deploy = readFileSync(resolve(repoRoot, "config/deploy.yml"), "utf8");
const workflow = readFileSync(
	resolve(repoRoot, ".github/workflows/clawdi-image-release.yml"),
	"utf8",
);
const deployHelper = readFileSync(resolve(repoRoot, "scripts/deploy-whatsapp-sidecar.sh"), "utf8");
const dockerfile = readFileSync(
	resolve(repoRoot, "packages/whatsapp-baileys-sidecar/Dockerfile"),
	"utf8",
);
const lockfile = readFileSync(resolve(repoRoot, "bun.lock"), "utf8");
const cliPackage = readFileSync(resolve(repoRoot, "packages/cli/package.json"), "utf8");
const sidecarPackage = readFileSync(
	resolve(repoRoot, "packages/whatsapp-baileys-sidecar/package.json"),
	"utf8",
);
const sqliteStateSource = readFileSync(
	resolve(repoRoot, "packages/whatsapp-baileys-sidecar/src/sqlite-state.ts"),
	"utf8",
);
const sqliteStateTestSource = readFileSync(
	resolve(repoRoot, "packages/whatsapp-baileys-sidecar/src/sqlite-state.test.ts"),
	"utf8",
);
const tsconfigBase = readFileSync(resolve(repoRoot, "tsconfig.base.json"), "utf8");

describe("WhatsApp sidecar production deployment contract", () => {
	test("uses one fixed business-neutral accessory and a clean session state root", () => {
		expect(deploy.match(/^ {2}whatsapp-baileys:$/gm)).toHaveLength(1);
		expect(deploy).toContain("service: clawdi-whatsapp-baileys");
		expect(deploy).toContain('ENV["WHATSAPP_TAILSCALE_EGRESS_ENABLED"] == "true"');
		expect(deploy).toContain('? "container:clawdi-whatsapp-netns" : "bridge"');
		expect(deploy).not.toContain("CLAWDI_WA_SIDECAR_PROXY_URL");
		expect(deploy).toContain("/home/phala/clawdi-whatsapp/state");
		expect(deploy).toContain("/home/phala/clawdi-whatsapp/run");
		expect(deploy).toContain("CLAWDI_WA_SIDECAR_STATE_ROOT: /data");
		expect(deploy).toContain("CLAWDI_WA_SIDECAR_SOCKET_PATH: /run/clawdi-whatsapp/sidecar.sock");
		expect(deploy).toContain("CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN");
		expect(deploy).not.toContain("whatsapp_accounts");
	});

	test("gates a pinned kernel-mode Tailscale network namespace", () => {
		expect(deploy.match(/^ {2}whatsapp-netns:$/gm)).toHaveLength(1);
		expect(deploy.match(/^ {2}whatsapp-egress-guard:$/gm)).toHaveLength(1);
		expect(deploy.match(/^ {2}whatsapp-tailscale:$/gm)).toHaveLength(1);
		expect(deploy).toContain(
			"registry.k8s.io/pause:3.10.1@sha256:278fb9dbcca9518083ad1e11276933a2e96f23de604a3a08cc3c80002767d24c",
		);
		expect(deploy).toContain(
			"tailscale/tailscale:v1.98.10@sha256:cdf5612ded5be1344f1a704b8c5e53496db97376bb533e5e15f141e48bf60cc0",
		);
		expect(deploy).toContain("TS_STATE_DIR: /var/lib/tailscale");
		expect(deploy).toContain('TS_USERSPACE: "false"');
		expect(deploy).toContain('TS_ACCEPT_DNS: "true"');
		expect(deploy).toContain('TS_AUTH_ONCE: "true"');
		expect(deploy).toContain("--exit-node-allow-lan-access=false");
		expect(deploy).toContain("/dev/net/tun:/dev/net/tun");
		expect(deploy).toContain("NET_ADMIN");
		expect(deploy).toContain("NET_RAW");
		expect(deploy).toContain("iptables -I OUTPUT 1 -m owner --uid-owner 1000");
		expect(deploy).not.toContain("ip6tables");
		expect(deployHelper).toContain("docker network inspect --format '{{.EnableIPv6}}' kamal");
		expect(deployHelper).toContain("/bin/sh -ceu 'ip link show tailscale0");
		expect(deploy).toContain("network-namespace.ready");
		expect(deploy).toContain("TS_AUTHKEY");
		expect(workflow).toContain('*[!A-Za-z0-9_-]*|"")');
		expect(workflow).toContain('[ "$' + '{#TS_AUTHKEY}" -lt 20 ]');
		expect(workflow).toContain('[ "$' + '{#TS_AUTHKEY}" -gt 512 ]');
	});

	test("prepares transparent egress before recreating the sidecar", () => {
		const helperCall = workflow.lastIndexOf("scripts/deploy-whatsapp-sidecar.sh");
		const appDeploy = workflow.indexOf(
			`kamal deploy -P --version "\${{ needs.build.outputs.image_tag }}"`,
		);

		expect(helperCall).toBeGreaterThan(0);
		expect(appDeploy).toBeGreaterThan(helperCall);
		expect(workflow).toContain("Build and push WhatsApp sidecar image");
		expect(deployHelper).toContain("kamal accessory directories whatsapp-baileys");
		expect(workflow).toContain("scripts/deploy-whatsapp-sidecar.sh");
		expect(workflow).toContain(
			"scripts/deploy-whatsapp-sidecar.sh --print-tailscale-config-revision",
		);
		expect(workflow.indexOf("--print-tailscale-config-revision")).toBeLessThan(helperCall);
		expect(deployHelper).toContain("WhatsApp Tailscale config revision does not match");
		expect(deployHelper).toContain("kamal accessory reboot whatsapp-tailscale");
		expect(deployHelper).toContain("kamal accessory reboot whatsapp-egress-guard");
		expect(deployHelper).toContain("kamal accessory reboot whatsapp-baileys");
		expect(deployHelper).not.toContain("api.ipify.org");
		expect(deployHelper).not.toContain("WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP");
		expect(workflow).not.toContain("WHATSAPP_TAILSCALE_EXPECTED_PUBLIC_IP");
	});

	test("compares desired and actual network mode independently of image revision", () => {
		expect(deployHelper).toContain("actual_network=");
		expect(deployHelper).toContain("'{{.HostConfig.NetworkMode}}'");
		expect(deployHelper).toContain('[[ "$' + '{actual_network}" == "$' + '{desired_network}" ]]');
		expect(deployHelper).toContain("infra_netns_inode");
		expect(deployHelper).toContain("docker exec '$1' stat -Lc %i /proc/self/ns/net");
		expect(deployHelper).toContain('desired_network="container:$' + '{infra_id}"');
		expect(deployHelper).not.toContain("/proc/$" + "{pid}/ns/net");
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

	test("keeps CLI-only release metadata outside the sidecar deployment revision", () => {
		const baseline = calculateWhatsAppSidecarDeploymentRevision(repoRoot);
		const cliOnly = calculateWhatsAppSidecarDeploymentRevision(
			repoRoot,
			new Map([
				[
					"packages/cli/package.json",
					replaceOnce(cliPackage, '"version": "0.13.45"', '"version": "0.13.46"'),
				],
				["bun.lock", replaceOnce(lockfile, '"version": "0.13.45"', '"version": "0.13.46"')],
			]),
		);
		const unrelatedDeploy = calculateWhatsAppSidecarDeploymentRevision(
			repoRoot,
			new Map([
				["config/deploy.yml", replaceOnce(deploy, "shared_buffers=512MB", "shared_buffers=513MB")],
			]),
		);
		const testOnly = calculateWhatsAppSidecarDeploymentRevision(
			repoRoot,
			new Map([
				[
					"packages/whatsapp-baileys-sidecar/src/sqlite-state.test.ts",
					`${sqliteStateTestSource}\n// test-only revision probe\n`,
				],
			]),
		);

		expect(cliOnly).toBe(baseline);
		expect(unrelatedDeploy).toBe(baseline);
		expect(testOnly).toBe(baseline);
	});

	test("changes revision for every effective sidecar runtime and build input class", () => {
		const baseline = calculateWhatsAppSidecarDeploymentRevision(repoRoot);
		const cases: Array<[string, ReadonlyMap<string, string>]> = [
			[
				"runtime source",
				new Map([
					[
						"packages/whatsapp-baileys-sidecar/src/sqlite-state.ts",
						`${sqliteStateSource}\n// runtime revision probe\n`,
					],
				]),
			],
			[
				"package manifest copied into the final image",
				new Map([
					[
						"packages/whatsapp-baileys-sidecar/package.json",
						replaceOnce(sidecarPackage, '"version": "0.1.0"', '"version": "0.1.1"'),
					],
				]),
			],
			[
				"resolved transitive dependency",
				new Map([["bun.lock", replaceOnce(lockfile, "sha512-WK+X8ju8", "sha512-XK+X8ju8")]]),
			],
			[
				"compiler configuration",
				new Map([
					[
						"tsconfig.base.json",
						replaceOnce(tsconfigBase, '"target": "ES2022"', '"target": "ES2023"'),
					],
				]),
			],
			[
				"sidecar accessory configuration",
				new Map([
					[
						"config/deploy.yml",
						replaceOnce(
							deploy,
							"CLAWDI_WA_SIDECAR_LOG_LEVEL: info",
							"CLAWDI_WA_SIDECAR_LOG_LEVEL: warn",
						),
					],
				]),
			],
			[
				"pinned runtime base image",
				new Map([
					[
						"packages/whatsapp-baileys-sidecar/Dockerfile",
						replaceOnce(dockerfile, "node:24.18.0-alpine", "node:24.18.1-alpine"),
					],
				]),
			],
		];

		for (const [label, overrides] of cases) {
			expect(calculateWhatsAppSidecarDeploymentRevision(repoRoot, overrides), label).not.toBe(
				baseline,
			);
		}
	});

	test("resolves the pinned sidecar dependency closure instead of hashing the whole lockfile", () => {
		const closure = sidecarDependencyClosure(lockfile);
		expect(Object.keys(closure)).toEqual(
			expect.arrayContaining([
				"baileys",
				"baileys/pino",
				"baileys/pino/pino-abstract-transport",
				"pino",
				"protobufjs",
				"typescript",
				"@types/node",
				"vitest",
			]),
		);
		expect(closure).not.toHaveProperty("clawdi");
		expect(closure).not.toHaveProperty("web");
	});
});

function replaceOnce(source: string, current: string, replacement: string): string {
	const first = source.indexOf(current);
	if (first < 0 || source.indexOf(current, first + current.length) >= 0) {
		throw new Error(`expected one revision fixture occurrence of ${current}`);
	}
	return `${source.slice(0, first)}${replacement}${source.slice(first + current.length)}`;
}
