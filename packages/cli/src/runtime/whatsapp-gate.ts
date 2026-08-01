// Application adapters have not passed a local fake end-to-end run against the
// installed OpenClaw and Hermes extension contracts. Keep projection off.
export const WHATSAPP_APPLICATION_RUNTIME_PROJECTION_READY = false;

// Historical native Baileys credential projection is retained only for cleanup
// compatibility. It must never materialize auth state into managed runtimes.
export const WHATSAPP_LEGACY_RUNTIME_PROJECTION_READY = false;
