// WhatsApp runtime wiring is disabled for the gated beta across OpenClaw and
// Hermes. OpenClaw's wsUrl path is a stopgap that has not passed a live pairing
// drill, and Hermes needs the Baileys WSS egress profile before it can reach the
// Clawdi relay instead of upstream WhatsApp directly.
export const WHATSAPP_UPSTREAM_READY = false;
