import { expect, test } from "bun:test";
import type { components } from "@clawdi/shared/api";
import {
	canManageSharing,
	linkIsActive,
	safeShareUrl,
	shareTokenFromUrl,
} from "./project-sharing-state";

test("sharing controls require ownership of an active user-created project", () => {
	const project: components["schemas"]["ProjectResponse"] = {
		id: "project",
		name: "Research",
		slug: "research",
		kind: "workspace",
		description: null,
		origin_environment_id: null,
		archived_at: null,
		created_at: "2026-10-03T00:00:00Z",
		is_owner: true,
		skill_count: 0,
		vault_count: 0,
		agent_count: 0,
		member_count: 0,
	};
	expect(canManageSharing(project)).toBe(true);
	expect(canManageSharing({ ...project, is_owner: false })).toBe(false);
	expect(canManageSharing({ ...project, kind: "personal" })).toBe(false);
	expect(canManageSharing({ ...project, kind: "environment" })).toBe(false);
	expect(canManageSharing({ ...project, archived_at: "2026-10-03T00:00:00Z" })).toBe(false);
});

test("share presentation accepts only credential-free HTTPS URLs", () => {
	expect(safeShareUrl("https://example.test/share/token")).toBe("https://example.test/share/token");
	for (const value of [
		"javascript:alert(1)",
		"file:///share",
		"http://example.test/share",
		"https://user:secret@example.test/share",
		"invalid",
	]) {
		expect(safeShareUrl(value)).toBeNull();
	}
});

test("revoked, expired and malformed expiry links are not displayed as active", () => {
	const link: components["schemas"]["ShareLinkResponse"] = {
		id: "link",
		prefix: "prefix",
		label: null,
		created_at: "2026-10-03T00:00:00Z",
		expires_at: null,
		revoked_at: null,
		redeem_count: 0,
		last_redeemed_at: null,
	};
	const now = Date.parse("2026-10-03T12:00:00Z");
	expect(linkIsActive(link, now)).toBe(true);
	expect(linkIsActive({ ...link, revoked_at: "2026-10-03T00:00:00Z" }, now)).toBe(false);
	expect(linkIsActive({ ...link, expires_at: "2026-10-03T12:00:00Z" }, now)).toBe(false);
	expect(linkIsActive({ ...link, expires_at: "2026-10-04T00:00:00Z" }, now)).toBe(true);
	expect(linkIsActive({ ...link, expires_at: "invalid" }, now)).toBe(false);
});

test("invite parsing extracts only a server-shaped token, not an arbitrary URL or API path", () => {
	const token = "a".repeat(43);
	expect(shareTokenFromUrl(`https://example.test/share/${token}`)).toBe(token);
	expect(shareTokenFromUrl(` https://example.test/prefix/share/${token}/?utm_source=mail `)).toBe(
		token,
	);
	for (const link of [
		`http://example.test/share/${token}`,
		`https://user:pass@example.test/share/${token}`,
		`https://example.test/v1/share/${token}/upgrade`,
		`https://example.test/share/${token}/extra`,
		"https://example.test/share/short",
		`https://example.test/share/${"a".repeat(44)}`,
		`https://example.test/share/${"a".repeat(42)}%2F`,
		token,
	])
		expect(shareTokenFromUrl(link)).toBeNull();
});
