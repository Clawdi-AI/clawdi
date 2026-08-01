# Native Channels Backend Plan (Historical)

> HISTORICAL - This plan described the first native-channel backend, including
> a retired WhatsApp Cloud transport and a FastAPI protocol emulator. Those
> WhatsApp paths are no longer part of the architecture. See
> [`../designs/whatsapp-baileys-sidecar-runtime.md`](../designs/whatsapp-baileys-sidecar-runtime.md)
> for the current single-owner Baileys boundary and
> [`../architecture.md`](../architecture.md) for current service ownership.

The implemented Telegram, Discord, iMessage, and generic channel behavior is
documented by the owner docs linked from [`../../AGENTS.md`](../../AGENTS.md).
This file remains only so historical links resolve; do not use it as an
implementation checklist.

Done: `rg -n "channels-native-backend" AGENTS.md docs README.md` shows only
historical references or links to current owner docs.
