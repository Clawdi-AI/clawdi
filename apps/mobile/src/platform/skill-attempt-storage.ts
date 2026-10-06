import * as SecureStore from "expo-secure-store";
import { createSkillAttemptStore } from "@/platform/skill-attempt";
export const skillAttempts = createSkillAttemptStore(SecureStore);
