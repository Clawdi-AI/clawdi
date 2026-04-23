import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "../src/lib/frontmatter";

describe("parseFrontmatter", () => {
	it("parses a plain name + description block", () => {
		const src = `---
name: my-skill
description: Does the thing
---

# My Skill

body here`;
		const { data, content } = parseFrontmatter(src);
		expect(data).toEqual({ name: "my-skill", description: "Does the thing" });
		expect(content.trim()).toContain("body here");
	});

	it("de-quotes double-quoted values", () => {
		const src = `---
name: "my-skill"
description: "hello: world"
---
x`;
		const { data } = parseFrontmatter(src);
		expect(data.name).toBe("my-skill");
		expect(data.description).toBe("hello: world");
	});

	it("de-quotes single-quoted values", () => {
		const src = `---
name: 'my-skill'
---
x`;
		const { data } = parseFrontmatter(src);
		expect(data.name).toBe("my-skill");
	});

	it("returns the original content when no frontmatter present", () => {
		const src = "# Just markdown\n\nno frontmatter";
		const { data, content } = parseFrontmatter(src);
		expect(data).toEqual({});
		expect(content).toBe(src);
	});

	it("skips blank lines and YAML comments", () => {
		const src = `---
# a comment
name: my-skill

description: hi
---
x`;
		const { data } = parseFrontmatter(src);
		expect(data).toEqual({ name: "my-skill", description: "hi" });
	});

	it("does not support JS frontmatter (---js)", () => {
		// Without `---` delimiter, we return empty data; there is no JS path.
		const src = "---js\nconst x = 1;\n---\nbody";
		const { data } = parseFrontmatter(src);
		expect(data).toEqual({});
	});
});
