import * as SecureStore from "expo-secure-store";
import { createAttemptStore } from "@/platform/creation-attempt-store";

export const { readSavedAttempt, saveAttempt, replaceAttempt, clearAttempt } =
	createAttemptStore(SecureStore);
