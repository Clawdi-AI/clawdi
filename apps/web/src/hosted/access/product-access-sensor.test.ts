import { expect, mock, test } from "bun:test";
import { publishProductAccessProjection } from "@/hosted/access/product-access-projection";
import { LOADING_PRODUCT_ACCESS, type ProductAccess } from "@/lib/product-access";

test("unchanged product access is not republished to the stable dashboard provider", () => {
	const lastPublished: { current: ProductAccess | null } = { current: null };
	const onChange = mock(() => {});
	const initial = { ...LOADING_PRODUCT_ACCESS };

	publishProductAccessProjection(lastPublished, initial, onChange);
	publishProductAccessProjection(lastPublished, { ...initial }, onChange);

	expect(onChange).toHaveBeenCalledTimes(1);
	expect(lastPublished.current).toBe(initial);

	const resolved = {
		...initial,
		status: "allowed",
		isLoading: false,
		isAllowed: true,
		isFetching: false,
	} satisfies ProductAccess;
	publishProductAccessProjection(lastPublished, resolved, onChange);
	expect(onChange).toHaveBeenCalledTimes(2);
});
