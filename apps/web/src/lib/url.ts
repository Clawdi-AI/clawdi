/** Decode a URL component without letting malformed percent escapes crash UI boundaries. */
export function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
