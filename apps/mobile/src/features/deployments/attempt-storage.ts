import * as SecureStore from "expo-secure-store";
import { createRuntimeAttemptStore } from "./attempt";

export const runtimeAttempts = createRuntimeAttemptStore(SecureStore);
