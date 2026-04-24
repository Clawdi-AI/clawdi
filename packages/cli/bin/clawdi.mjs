#!/usr/bin/env bun
// Thin wrapper that forwards to the bundled CLI. The clawdi CLI requires
// Bun to run (Hermes adapter uses bun:sqlite). On Node 22+ enable the
// compile cache for faster startup; on older Node / Bun this is a no-op.
import module from "node:module";

if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
	try {
		module.enableCompileCache();
	} catch {
		// Ignore — cache is an optimization, not a requirement.
	}
}

await import("../dist/index.js");
