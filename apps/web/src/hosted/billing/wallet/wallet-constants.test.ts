import { describe, expect, test } from "bun:test";
import {
	AUTORELOAD_AMOUNT_RANGE_LABEL,
	TOPUP_AMOUNT_RANGE_LABEL,
} from "@/hosted/billing/wallet/wallet-constants";

describe("wallet amount range labels", () => {
	test("formats both ranges consistently from their cent bounds", () => {
		expect(TOPUP_AMOUNT_RANGE_LABEL).toBe("$10.00–$2,000.00");
		expect(AUTORELOAD_AMOUNT_RANGE_LABEL).toBe("$5.00–$500.00");
	});
});
