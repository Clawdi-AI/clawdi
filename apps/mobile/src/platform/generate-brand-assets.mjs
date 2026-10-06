/** Run with Bun from the repository root after bun install. Uses the exact Web marks. */
import { createElement } from "react";
import { renderToStaticMarkup } from "../../../web/node_modules/react-dom/server";

const source = await Bun.file("apps/web/src/components/entity-brand-icons.ts").text();
const assets = {};
for (const match of source.matchAll(/import (\w+) from "(@lobehub\/icons[^"]+)"/g)) {
	const [, name, path] = match;
	const { default: Mark } = await import(`../../../web/node_modules/${path}`);
	assets[name] = renderToStaticMarkup(createElement(Mark, { size: "100%" }))
		.replace(/<title>.*?<\/title>/g, "")
		.replace(/ style="[^"]*"/g, "");
}
await Bun.write(
	"apps/mobile/src/platform/brand-assets.generated.ts",
	`/** Generated from Web's @lobehub/icons marks; regenerate with generate-brand-assets.mjs. */\nexport const brandAssets = ${JSON.stringify(assets, null, "\t")} as const;\n`,
);
