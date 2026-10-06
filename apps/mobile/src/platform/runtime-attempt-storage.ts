import * as SecureStore from "expo-secure-store";
import { createRuntimeAttemptStore } from "@/platform/runtime-attempt";

export const runtimeAttempts = createRuntimeAttemptStore(SecureStore);
