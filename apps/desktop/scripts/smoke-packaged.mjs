import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron } from "@playwright/test";

const [executablePath, runtimeRoot] = process.argv.slice(2);
if (!executablePath || !runtimeRoot) {
	throw new Error("usage: smoke-packaged.mjs <executable> <runtime-root>");
}

const home = join(runtimeRoot, "home");
const clawdiHome = join(runtimeRoot, "state");
mkdirSync(home, { recursive: true });
mkdirSync(clawdiHome, { recursive: true });

const desktop = await electron.launch({
	executablePath,
	env: { ...process.env, HOME: home, CLAWDI_HOME: clawdiHome },
	timeout: 30_000,
});

try {
	const window = await desktop.firstWindow({ timeout: 30_000 });
	const signIn = window.getByRole("heading", { name: "Sign in to Clawdi" });
	const failure = window.getByRole("heading", { name: "Couldn't finish setup" });
	await Promise.race([
		signIn.waitFor({ state: "visible", timeout: 20_000 }),
		failure.waitFor({ state: "visible", timeout: 20_000 }).then(async () => {
			throw new Error(`Packaged setup failed:\n${await window.locator("body").innerText()}`);
		}),
	]);
} finally {
	await desktop.close();
}
