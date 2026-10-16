import * as SecureStore from "expo-secure-store";
import { createSubscriptionAttemptStore } from "@/hosted/billing/subscription/subscription-attempt";

export const subscriptionAttempts = createSubscriptionAttemptStore(SecureStore);
