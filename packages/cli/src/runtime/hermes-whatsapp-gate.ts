// Official Hermes does not yet support a custom Baileys websocket URL
// (--ws-url). Enabling WhatsApp before that lands would make Hermes connect
// directly to WhatsApp with the relay credentials, risking session conflicts
// and bypassing the Clawdi broker path.
export const HERMES_WHATSAPP_UPSTREAM_READY = false;
