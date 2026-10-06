import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AGENT_FILES } from "@/lib/agent-files";
import { parseFrontmatter } from "../../../../packages/cli/src/lib/frontmatter";

const instanceOrigin = "https://self-hosted.example";
const cacheControl = "public, max-age=300, s-maxage=300, stale-while-revalidate=86400";
const skillBytes = readFileSync(
	new URL("../../../../packages/cli/skills/clawdi/SKILL.md", import.meta.url),
);
const guidePath = new URL("../content/get-started.md", import.meta.url);
const responseSchema = z.object({
	status: z.number(),
	headers: z.record(z.string(), z.string()),
	body: z.string(),
});
const responsesSchema = z.record(z.string(), responseSchema);

// Separate processes exercise the real validated env in both deployment modes,
// without mocking env or leaking module mocks into the rest of the web suite.
async function routeResponses(hosted: boolean, marketingUrl = "https://clawdi.ai/home") {
	const script = `
import { GET as guide } from "./src/routes/get-started[.]md.ts";
import { GET as skill } from "./src/routes/skills/clawdi/SKILL[.]md.ts";
import { GET as index } from "./src/routes/[.]well-known/agent-skills/index[.]json.ts";
import { GET as redirect } from "./src/routes/skill[.]md.ts";
import { GET as llms } from "./src/routes/llms[.]txt.ts";
const responses = {};
for (const [path, handler] of Object.entries({
  "/get-started.md": guide,
  "/skills/clawdi/SKILL.md": skill,
  "/.well-known/agent-skills/index.json": index,
  "/skill.md": redirect,
  "/llms.txt": llms,
})) {
  const response = handler({ request: new Request(${JSON.stringify(instanceOrigin)} + path) });
  responses[path] = {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}
process.stdout.write(JSON.stringify(responses));
`;
	const proc = Bun.spawn(["bun", "--preload", "./test-setup.ts", "-e", script], {
		cwd: fileURLToPath(new URL("../../", import.meta.url)),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			VITE_CLAWDI_HOSTED: String(hosted),
			VITE_CLAWDI_MARKETING_URL: marketingUrl,
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(code, stderr).toBe(0);
	return responsesSchema.parse(JSON.parse(stdout));
}

for (const hosted of [false, true]) {
	describe(`agent-facing routes (${hosted ? "hosted" : "OSS"})`, () => {
		let responses: z.infer<typeof responsesSchema>;
		const publicOrigin = hosted ? "https://clawdi.ai" : instanceOrigin;

		beforeAll(async () => {
			responses = await routeResponses(hosted);
		});

		test("serves unchanged skill bytes and matching discovery RFC v0.2.0 metadata", () => {
			const skill = responses["/skills/clawdi/SKILL.md"];
			expect(skill.status).toBe(200);
			expect(Buffer.from(skill.body)).toEqual(skillBytes);
			const metadata = parseFrontmatter(skillBytes.toString("utf8")).data;
			expect(metadata.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
			expect(metadata.name.length).toBeLessThanOrEqual(64);
			expect(metadata.description.length).toBeLessThanOrEqual(1024);
			const index = responses["/.well-known/agent-skills/index.json"];
			expect(index.status).toBe(200);
			expect(JSON.parse(index.body)).toEqual({
				$schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
				skills: [
					{
						name: metadata.name,
						description: metadata.description,
						type: "skill-md",
						url: "/skills/clawdi/SKILL.md",
						digest: `sha256:${createHash("sha256").update(skillBytes).digest("hex")}`,
					},
				],
			});
		});

		test("redirects the legacy guide permanently to the public origin", () => {
			const response = responses["/skill.md"];
			expect(response.status).toBe(301);
			expect(response.headers.location).toBe(`${publicOrigin}/get-started.md`);
			expect(existsSync(guidePath)).toBe(true);
			expect(existsSync(new URL("../../public/skill.md", import.meta.url))).toBe(false);
		});

		test("serves consistent llms links for users and agents", () => {
			const llms = responses["/llms.txt"];
			expect(llms.status).toBe(200);
			for (const path of [
				"/get-started.md",
				"/skills/clawdi/SKILL.md",
				"/.well-known/agent-skills/index.json",
			]) {
				expect(llms.body).toContain(`${publicOrigin}${path}`);
			}
			expect(llms.body).toContain("https://docs.clawdi.ai/llms.txt");
			expect(llms.body).toContain("https://clawdi.ai/install.sh");
			expect(llms.body).toContain(`[Dashboard](${instanceOrigin}/)`);
			expect(llms.body).not.toContain("/skill.md");
		});

		test("serves device sign-in and automatic history upload instructions", () => {
			const guide = responses["/get-started.md"].body;
			const signIn = guide.split("## Sign in\n")[1]?.split("\n## ")[0];
			expect(signIn).toContain("clawdi auth login\n");
			expect(signIn).toContain("clawdi auth complete");
			expect(signIn).toContain("Only relay");
			expect(signIn).toContain("the link and code that your own command printed");
			expect(signIn).toContain("Never invent a sign-in URL or code");
			expect(signIn).not.toMatch(/127\.0\.0\.1|callback URL|printf|--no-open/);
			expect(guide).toContain("Don't ask any other questions.");
			expect(guide).toContain("clawdi update --yes");
			expect(guide).toContain("clawdi push --modules sessions --all-agents --all --json");
			expect(guide).toContain("totals.sessions");
			expect(guide).toContain("new + updated + unchanged");
			expect(guide).toContain("DeepSeek Harness (`dsh`)");
			expect(guide).toContain("To skip a project: `clawdi config set excludeProjects <path>`");
			expect(guide).toContain("Agents that aren't installed on this machine show as skipped.");
			expect(guide).not.toContain("exits 1 in that case");
		});

		test("serves a plain guide with the approved SEO, caching, and content headers", () => {
			const guide = responses["/get-started.md"];
			expect(guide.status).toBe(200);
			expect(Buffer.from(guide.body)).toEqual(readFileSync(guidePath));
			expect(guide.body.startsWith("# Clawdi Setup\n")).toBe(true);
			expect(guide.body).toContain(
				"Don't install https://clawdi.ai/skills/clawdi/SKILL.md separately.",
			);
			expect(guide.body).not.toContain("https://cloud.clawdi.ai/sessions");
			if (hosted) {
				expect(guide.headers.link).toBe(
					'<https://docs.clawdi.ai/getting-started/connect-agents>; rel="canonical"',
				);
			} else {
				expect(guide.headers.link).toBeUndefined();
			}
			for (const [path, response] of Object.entries(responses)) {
				expect(response.headers["cache-control"], path).toBe(cacheControl);
				expect(response.headers["x-content-type-options"], path).toBe("nosniff");
				const machineFile = [
					"/skills/clawdi/SKILL.md",
					"/.well-known/agent-skills/index.json",
				].includes(path);
				if (machineFile) {
					expect(response.headers["x-robots-tag"], path).toBe("noindex");
				} else {
					expect(response.headers["x-robots-tag"], path).toBeUndefined();
				}
				const contentType =
					path.endsWith(".md") && path !== "/skill.md"
						? "text/markdown"
						: path.endsWith(".json")
							? "application/json"
							: "text/plain";
				expect(response.headers["content-type"], path).toBe(`${contentType}; charset=utf-8`);
				if (path.startsWith("/skills/") || path.endsWith(".json")) {
					expect(response.headers["access-control-allow-origin"], path).toBe("*");
				} else {
					expect(response.headers["access-control-allow-origin"], path).toBeUndefined();
				}
			}
		});
	});
}

test("hosted public files reuse the configured marketing origin without its path", async () => {
	const responses = await routeResponses(true, "https://public.example/home");
	expect(responses["/skill.md"].headers.location).toBe("https://public.example/get-started.md");
	expect(responses["/llms.txt"].body).toContain("https://public.example/get-started.md");
});

test("the dashboard uses the shared prompt and public-site helper", () => {
	const dashboard = readFileSync(
		new URL("../components/dashboard/add-agent-setup.tsx", import.meta.url),
		"utf8",
	);
	expect(dashboard).toContain('import { agentSetupPrompt } from "@/lib/agent-setup-prompt"');
	expect(dashboard).toContain("agentSetupPrompt(publicSiteOrigin(origin))");
	expect(dashboard).not.toContain("Set up Clawdi on this machine.");
});

test("the generated runtime routes preserve the escaped .well-known directory", () => {
	const tree = readFileSync(new URL("../routeTree.gen.ts", import.meta.url), "utf8");
	const runtime = tree.slice(0, tree.indexOf("export interface FileRoutesByFullPath"));
	for (const { path } of Object.values(AGENT_FILES)) {
		expect(runtime).toContain(`path: '${path}'`);
	}
});

test("no static public file shadows an agent-facing server route", () => {
	for (const { path } of Object.values(AGENT_FILES)) {
		expect(existsSync(new URL(`../../public${path}`, import.meta.url)), path).toBe(false);
	}
});
