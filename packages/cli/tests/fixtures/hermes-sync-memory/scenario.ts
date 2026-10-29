// Both fixtures run on Node 24; many-medium exercises the published daemon entrypoint.
if (process.argv.includes("--many-medium")) await import("./many-medium");
else await import("./large-session");

export {};
