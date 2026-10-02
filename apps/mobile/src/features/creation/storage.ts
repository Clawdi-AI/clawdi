import * as SecureStore from "expo-secure-store";
import { createAttemptStore } from "./attempt-store";

export const { readSavedAttempt, saveAttempt, replaceAttempt, clearAttempt } =
	createAttemptStore(SecureStore);
