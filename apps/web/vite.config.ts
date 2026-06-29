import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";

const GATED_BUILD_MODULE_PATTERNS = ["/src/hosted/", "/src/v2/", "/node_modules/posthog-js/"];

function normalizeModuleId(id: string) {
	return id.replaceAll("\\", "/");
}

function isGatedBuildModule(id: string) {
	const normalized = normalizeModuleId(id);
	return GATED_BUILD_MODULE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function ossHostedBoundaryPlugin(isHostedBuild: boolean): Plugin {
	return {
		name: "clawdi-oss-hosted-boundary",
		apply: "build",
		enforce: "post",
		generateBundle(_options, bundle) {
			if (isHostedBuild) return;

			const removedChunks = new Set<string>();
			for (const [fileName, output] of Object.entries(bundle)) {
				if (output.type !== "chunk") continue;
				if (Object.keys(output.modules).some(isGatedBuildModule)) {
					removedChunks.add(fileName);
				}
			}

			let changed = true;
			while (changed) {
				changed = false;
				const importers = new Map<string, Set<string>>();
				for (const [fileName, output] of Object.entries(bundle)) {
					if (removedChunks.has(fileName) || output.type !== "chunk") continue;
					for (const imported of [...output.imports, ...output.dynamicImports]) {
						if (!importers.has(imported)) importers.set(imported, new Set());
						importers.get(imported)?.add(fileName);
					}
				}

				for (const [fileName, output] of Object.entries(bundle)) {
					if (removedChunks.has(fileName) || output.type !== "chunk") continue;
					if (output.isEntry || output.isDynamicEntry) continue;
					const remainingImporters = importers.get(fileName);
					if (!remainingImporters || remainingImporters.size === 0) {
						removedChunks.add(fileName);
						changed = true;
					}
				}
			}

			for (const fileName of removedChunks) {
				delete bundle[fileName];
			}
		},
	};
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), ["NEXT_PUBLIC_"]);
	const isHostedBuild =
		(process.env.NEXT_PUBLIC_CLAWDI_HOSTED ?? env.NEXT_PUBLIC_CLAWDI_HOSTED) === "true";
	const hostedBuildFlag = isHostedBuild ? "true" : "false";

	return {
		server: {
			port: 3000,
		},
		envPrefix: ["VITE_", "NEXT_PUBLIC_"],
		define: {
			"import.meta.env.NEXT_PUBLIC_CLAWDI_HOSTED": JSON.stringify(hostedBuildFlag),
		},
		resolve: {
			tsconfigPaths: true,
		},
		plugins: [
			tanstackRouter({ target: "react" }),
			tanstackStart(),
			nitro({ noExternals: true }),
			ossHostedBoundaryPlugin(isHostedBuild),
			tailwindcss(),
			viteReact(),
		],
	};
});
