import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

function generatedRuntimeRoutePaths(source: string): string[] {
	const runtimeStart = source.search(/^const \w+Route\s*=/m);
	const runtimeEnd = source.indexOf("export interface FileRoutesByFullPath");
	if (runtimeStart === -1 || runtimeEnd === -1 || runtimeStart >= runtimeEnd) {
		throw new Error("Generated route runtime construction section was not found");
	}

	const runtimeConstruction = source.slice(runtimeStart, runtimeEnd);
	return [...runtimeConstruction.matchAll(/\bpath:\s*'([^']+)'/g)].map((match) => match[1]);
}

describe("shared export routes", () => {
	it("preserves extension-style public export URLs", () => {
		const generatedRouteTree = readFileSync(
			new URL("../routeTree.gen.ts", import.meta.url),
			"utf8",
		);
		const paths = generatedRuntimeRoutePaths(generatedRouteTree);

		expect(paths).toContain("/s/{$id}.md");
		expect(paths).toContain("/s/{$id}.json");
		expect(paths).not.toContain("/s/{$}/md");
		expect(paths).not.toContain("/s/{$}/json");
	});

	it("ignores paths that exist only in generated type metadata", () => {
		const generatedRouteTree = `
const RuntimeRoute = RuntimeRouteImport.update({
  path: '/runtime-path',
} as any)
export interface FileRoutesByFullPath {
  '/metadata-only-path': { path: '/metadata-only-path' }
}
`;

		expect(generatedRuntimeRoutePaths(generatedRouteTree)).toEqual(["/runtime-path"]);
	});
});
