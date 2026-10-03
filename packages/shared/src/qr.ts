import { encode } from "uqr";

/** Local-only QR generation: no remote service, markup injection, or payload logging. */
export function pairingQr(value: string): { size: number; path: string } | null {
	if (!value || value.length > 4096) return null;
	try {
		const { data, size } = encode(value, { ecc: "M", border: 4 });
		const path = data
			.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x},${y}h1v1h-1z`] : [])))
			.join("");
		return { size, path };
	} catch {
		return null;
	}
}
