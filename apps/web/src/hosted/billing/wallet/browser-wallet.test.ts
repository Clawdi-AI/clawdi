import { describe, expect, test } from "bun:test";
import type { ClientEvmSigner } from "@clawdi/shared/x402";
import { toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	type BrowserWalletProvider,
	connectBrowserWallet,
} from "@/hosted/billing/wallet/browser-wallet";

const account = privateKeyToAccount(`0x${"a".repeat(64)}`);
const ADDRESS = account.address;
const SIGNATURE = toHex(new Uint8Array(65).fill(0xbb));
const TYPED_DATA = {
	domain: {
		name: "USD Coin",
		version: "2",
		chainId: 8453,
		verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	},
	types: {
		TransferWithAuthorization: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
		],
	},
	primaryType: "TransferWithAuthorization",
	message: { from: ADDRESS, to: `0x${"2".repeat(40)}`, value: 5_000_000n },
} as const satisfies Parameters<ClientEvmSigner["signTypedData"]>[0];

describe("browser wallet binding signer", () => {
	test("requests one account and signs only the backend challenge", async () => {
		const calls: Array<{ method: string; params?: readonly unknown[] }> = [];
		const provider: BrowserWalletProvider = {
			async request(args) {
				calls.push(args);
				if (args.method === "eth_requestAccounts") return [ADDRESS];
				if (args.method === "personal_sign") return SIGNATURE;
				if (args.method === "eth_signTypedData_v4") return account.signTypedData(TYPED_DATA);
				throw new Error("unexpected method");
			},
		};

		const wallet = await connectBrowserWallet(provider);
		await expect(wallet.signMessage("example.test wants you to sign in")).resolves.toBe(SIGNATURE);
		await expect(wallet.signTypedData(TYPED_DATA)).resolves.toBe(
			await account.signTypedData(TYPED_DATA),
		);
		expect(calls.slice(0, 2)).toEqual([
			{ method: "eth_requestAccounts" },
			{
				method: "personal_sign",
				params: [toHex("example.test wants you to sign in"), wallet.address],
			},
		]);
		expect(calls[2]?.method).toBe("eth_signTypedData_v4");
		expect(calls[2]?.params?.[0]).toBe(wallet.address);
		const serialized = calls[2]?.params?.[1];
		expect(typeof serialized).toBe("string");
		expect(JSON.parse(typeof serialized === "string" ? serialized : "{}")).toMatchObject({
			domain: {
				...TYPED_DATA.domain,
				verifyingContract: TYPED_DATA.domain.verifyingContract.toLowerCase(),
			},
			message: { ...TYPED_DATA.message, from: ADDRESS.toLowerCase(), value: "5000000" },
			primaryType: TYPED_DATA.primaryType,
			types: {
				EIP712Domain: [
					{ name: "name", type: "string" },
					{ name: "version", type: "string" },
					{ name: "chainId", type: "uint256" },
					{ name: "verifyingContract", type: "address" },
				],
			},
		});
	});

	test("rejects a non-65-byte binding signature without exposing provider details", async () => {
		const secretMarker = "provider-private-error";
		const provider: BrowserWalletProvider = {
			request: async ({ method }) => {
				if (method === "eth_requestAccounts") return [ADDRESS];
				if (method === "personal_sign") return `${toHex(new Uint8Array(64))}${secretMarker}`;
				throw new Error(secretMarker);
			},
		};
		let message = "";
		try {
			const wallet = await connectBrowserWallet(provider);
			await wallet.signMessage("example.test wants you to sign in");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("The browser wallet did not sign the binding request.");
		expect(message).not.toContain(secretMarker);
	});
});
