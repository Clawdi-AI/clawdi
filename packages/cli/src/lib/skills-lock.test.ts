import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readSkillProjectionClaimsForAgent,
	readSkillProjectionState,
	readSkillsLock,
	recordSkillProjectionClaim,
	removeSkillProjectionClaim,
	skillCacheKey,
	skillClaimCacheKey,
	writeSkillsLock,
} from "./skills-lock";

const tmp = mkdtempSync(join(tmpdir(), "clawdi-skills-lock-test-"));
const originalHome = process.env.HOME;
const originalClawdiHome = process.env.CLAWDI_HOME;

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
	else process.env.CLAWDI_HOME = originalClawdiHome;
});

beforeEach(() => {
	process.env.HOME = mkdtempSync(join(tmp, "case-"));
	delete process.env.CLAWDI_HOME;
});

function lockPath(): string {
	return join(process.env.HOME ?? "", ".clawdi", "skills-lock.json");
}

function writeRaw(value: unknown): void {
	const path = lockPath();
	const dir = join(process.env.HOME ?? "", ".clawdi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	if (!existsSync(dir)) throw new Error("expected lock parent");
}

describe("skills-lock v3 projection claims", () => {
	it("migrates v1 and v2 hashes as baselines without deletion authority", () => {
		writeRaw({ version: 1, skills: { alpha: { hash: "v1-hash" } } });
		let state = readSkillProjectionState("claude_code", "agent-a", "project-a");
		expect(state.claims.size).toBe(0);
		expect(state.legacyBaselines.get("alpha")).toBe("v1-hash");

		writeFileSync(
			lockPath(),
			`${JSON.stringify({
				version: 2,
				skills: {
					[skillCacheKey("claude_code", "alpha")]: { hash: "v2-hash" },
					[skillCacheKey("codex", "alpha")]: { hash: "other-adapter" },
				},
			})}\n`,
		);
		state = readSkillProjectionState("claude_code", "agent-a", "project-a");
		expect(state.claims.size).toBe(0);
		expect(state.legacyBaselines.get("alpha")).toBe("v2-hash");
		expect([...state.legacyBaselines.values()]).not.toContain("other-adapter");
	});

	it("keeps the most specific released baseline when legacy shapes coexist", () => {
		writeRaw({
			version: 2,
			skills: {
				alpha: { hash: "v1-hash" },
				[skillCacheKey("claude_code", "alpha")]: { hash: "v2-agent-hash" },
				"claude_code:project-a:alpha": { hash: "v2-project-hash" },
			},
		});

		const state = readSkillProjectionState("claude_code", "agent-a", "project-a");
		expect(state.claims.size).toBe(0);
		expect(state.legacyBaselines.get("alpha")).toBe("v2-project-hash");
	});

	it("records and reads claims only under the exact identity and Project fence", () => {
		recordSkillProjectionClaim({
			agentType: "claude_code",
			agentId: "agent-a",
			projectId: "project-a",
			skillKey: "nested/alpha",
			hash: "hash-a",
		});
		recordSkillProjectionClaim({
			agentType: "claude_code",
			agentId: "agent-a",
			projectId: "project-b",
			skillKey: "beta",
			hash: "hash-b",
		});

		const exact = readSkillProjectionState("claude_code", "agent-a", "project-a");
		expect([...exact.claims.entries()]).toEqual([["nested/alpha", "hash-a"]]);
		expect(readSkillProjectionState("claude_code", "agent-b", "project-a").claims.size).toBe(0);
		expect(readSkillProjectionState("codex", "agent-a", "project-a").claims.size).toBe(0);

		const allAgentClaims = readSkillProjectionClaimsForAgent("claude_code", "agent-a");
		expect(allAgentClaims.map((claim) => claim.project_id).sort()).toEqual([
			"project-a",
			"project-b",
		]);
		expect(readSkillsLock().version).toBe(3);
	});

	it("removes only an exact claim and does not accept an identity reassignment", () => {
		const identity = {
			agentType: "claude_code",
			agentId: "agent-a",
			projectId: "project-a",
			skillKey: "alpha",
		};
		recordSkillProjectionClaim({ ...identity, hash: "hash-a" });

		expect(removeSkillProjectionClaim({ ...identity, projectId: "project-b" })).toBe(false);
		expect(removeSkillProjectionClaim({ ...identity, agentType: "codex" })).toBe(false);
		expect(readSkillProjectionState("claude_code", "agent-a", "project-a").claims.size).toBe(1);
		expect(removeSkillProjectionClaim(identity)).toBe(true);
		expect(removeSkillProjectionClaim(identity)).toBe(false);
		expect(readSkillProjectionState("claude_code", "agent-a", "project-a").claims.size).toBe(0);
		expect(readSkillsLock().skills[skillCacheKey("claude_code", "alpha")]).toBeUndefined();
	});

	it("drops a claim whose key and repeated identity disagree", () => {
		const key = skillClaimCacheKey("agent-a", "project-a", "alpha");
		writeRaw({
			version: 3,
			skills: { alpha: { hash: "baseline-only" } },
			claims: {
				[key]: {
					agent_type: "claude_code",
					agent_id: "agent-a",
					project_id: "project-b",
					skill_key: "alpha",
					hash: "must-not-authorize-delete",
				},
			},
		});

		const state = readSkillProjectionState("claude_code", "agent-a", "project-a");
		expect(state.claims.size).toBe(0);
		expect(state.legacyBaselines.get("alpha")).toBe("baseline-only");
	});

	it("preserves a concurrently committed claim through a stale baseline write", () => {
		const stale = readSkillsLock();
		recordSkillProjectionClaim({
			agentType: "claude_code",
			agentId: "agent-a",
			projectId: "project-a",
			skillKey: "alpha",
			hash: "claim-hash",
		});
		stale.skills[skillCacheKey("claude_code", "beta")] = { hash: "baseline-hash" };
		writeSkillsLock(stale);

		expect(
			readSkillProjectionState("claude_code", "agent-a", "project-a").claims.get("alpha"),
		).toBe("claim-hash");
		expect(readSkillsLock().skills[skillCacheKey("claude_code", "beta")]?.hash).toBe(
			"baseline-hash",
		);
		const entries = readdirSync(join(process.env.HOME ?? "", ".clawdi"));
		expect(entries).toEqual(["skills-lock.json"]);
		expect(JSON.parse(readFileSync(lockPath(), "utf8")).version).toBe(3);
	});
});
