import type { StorePlatform } from "@clawdi/shared/api";
import { Platform } from "react-native";

/** The store that bills purchases made on this device. */
export function currentStorePlatform(): StorePlatform | null {
	return Platform.OS === "ios" ? "app_store" : Platform.OS === "android" ? "play_store" : null;
}
