import type { ClientEvmSigner } from "@clawdi/shared/x402";
import {
	type Address,
	createWalletClient,
	custom,
	getAddress,
	type Hex,
	isAddress,
	isHex,
	toHex,
	verifyTypedData,
} from "viem";

export interface BrowserWalletProvider {
	request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

export type BrowserWalletConnection = ClientEvmSigner & {
	address: Address;
	signMessage(message: string): Promise<Hex>;
};

export class BrowserWalletError extends Error {
	readonly code: "unavailable" | "connection_rejected" | "signing_rejected";

	constructor(code: BrowserWalletError["code"], message: string) {
		super(message);
		this.name = "BrowserWalletError";
		this.code = code;
	}
}

export async function connectBrowserWallet(
	provider: BrowserWalletProvider | null = injectedBrowserWalletProvider(),
): Promise<BrowserWalletConnection> {
	if (!provider) {
		throw new BrowserWalletError(
			"unavailable",
			"No browser wallet was found. Install or enable an EVM wallet and try again.",
		);
	}

	let address: Address;
	try {
		const accounts = await provider.request({ method: "eth_requestAccounts" });
		const first = Array.isArray(accounts) ? accounts[0] : undefined;
		if (typeof first !== "string" || !isAddress(first)) throw new Error("invalid account");
		address = getAddress(first);
	} catch {
		throw new BrowserWalletError(
			"connection_rejected",
			"The browser wallet did not provide an EVM account.",
		);
	}
	const walletClient = createWalletClient({
		account: address,
		transport: custom({
			request: ({ method, params }) => provider.request({ method, params }),
		}),
	});

	return {
		address,
		async signMessage(message) {
			if (!message || message.length > 16_384) {
				throw new BrowserWalletError(
					"signing_rejected",
					"The wallet binding challenge is invalid.",
				);
			}
			try {
				const signature = await provider.request({
					method: "personal_sign",
					params: [toHex(message), address],
				});
				if (!isEoaSignature(signature)) {
					throw new Error("invalid signature");
				}
				return signature;
			} catch {
				throw new BrowserWalletError(
					"signing_rejected",
					"The browser wallet did not sign the binding request.",
				);
			}
		},
		async signTypedData(typedData) {
			try {
				const signature = await walletClient.signTypedData(typedData);
				if (
					!isEoaSignature(signature) ||
					!(await verifyTypedData({ ...typedData, address, signature }))
				) {
					throw new Error("invalid signature");
				}
				return signature;
			} catch {
				throw new BrowserWalletError(
					"signing_rejected",
					"The browser wallet did not sign the x402 payment authorization.",
				);
			}
		},
	};
}

function isEoaSignature(value: unknown): value is Hex {
	return typeof value === "string" && isHex(value) && /^0x[0-9a-fA-F]{130}$/.test(value);
}

function injectedBrowserWalletProvider(): BrowserWalletProvider | null {
	if (typeof window === "undefined") return null;
	const candidate = Reflect.get(window, "ethereum");
	if (typeof candidate !== "object" || candidate === null) return null;
	const request = Reflect.get(candidate, "request");
	if (typeof request !== "function") return null;
	return {
		request: (args) => Promise.resolve(Reflect.apply(request, candidate, [args])),
	};
}
