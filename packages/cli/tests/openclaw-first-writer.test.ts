import { afterEach, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import {
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createOpenClawHostedContextForHome } from "../src/runtime/hosted-openclaw-context";
import {
	assertFirstWriterUnclaimed,
	FIRST_WRITER_SCRIPT,
	firstWriterPaths,
	openClawWriterSourceRevision,
	tryFirstOpenClawWrite,
	warmFirstOpenClawWriter,
} from "../src/runtime/openclaw-first-writer";
import {
	applyOpenClawContextMergePatch,
	beginOpenClawConfigTransaction,
	commitOpenClawConfigTransaction,
} from "../src/runtime/openclaw-provider-config";
import { getRuntimePaths } from "../src/runtime/paths";
import { withRuntimeUserFileAccess } from "../src/runtime/runtime-user-command";
import { warmHostedOpenClawRuntime } from "../src/runtime/runtime-warm";
import { managedRuntimeSystemdUnitEntries } from "../src/runtime/systemd";

let scratch = "";
const environment = { ...process.env };
afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = "";
	process.env = { ...environment };
});

test("anonymous writer is outside tenant inventory and cannot rewarm after submission", () => {
	scratch = mkdtempSync(join(tmpdir(), "first-writer-guard-"));
	const paths = { ...getRuntimePaths({ mode: "hosted" }), runRoot: scratch, statusRoot: scratch };
	writeFileSync(
		join(scratch, "openclaw-first-writer.service"),
		"# ClawdiAnonymousOpenClawWriter=v1\n",
	);
	expect(managedRuntimeSystemdUnitEntries(scratch)).toEqual([]);
	assertFirstWriterUnclaimed(paths);
	writeFileSync(firstWriterPaths(paths).used, "submitted\n");
	expect(() => assertFirstWriterUnclaimed(paths)).toThrow("submitted tenant config write");
});

test.each(["success", "rejected", "incomplete", "oversized"])(
	"inherited socket writer handles %s once and preserves native validation",
	async (mode) => {
		scratch = mkdtempSync(join(tmpdir(), "first-writer-protocol-"));
		const bin = join(scratch, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "systemd-notify"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		writeFileSync(join(scratch, "writer.mjs"), FIRST_WRITER_SCRIPT);
		writeFileSync(
			join(scratch, "sdk.mjs"),
			`
 import {readFileSync,writeFileSync} from "node:fs";
 const path=process.env.OPENCLAW_CONFIG_PATH;
 export async function readConfigFileSnapshotForWrite(options){
  if(options && options.skipPluginValidation!==true)throw new Error("bad preview");
  return {snapshot:{valid:true,sourceConfig:JSON.parse(readFileSync(path,"utf8"))}};
 }
 export async function mutateConfigFile(options){
  if(options.base!=="source"||options.afterWrite.mode!=="auto"||!options.writeOptions.allowConfigSizeDrop)
   throw new Error("missing native validation path");
  const draft=JSON.parse(readFileSync(path,"utf8"));options.mutate(draft);
  if(draft.reject)throw new Error("validation failed");
  writeFileSync(path,JSON.stringify(draft));
 }
 `,
		);
		writeFileSync(join(scratch, "config.json"), '{"native":"preserved"}');
		// The parent opens exactly the inherited fd that systemd supplies. No daemon,
		// host systemd, or private Node socket internals are needed for this regression.
		const python = `
import hashlib,json,os,socket,subprocess,sys,time
root,mode=sys.argv[1:]
s=socket.socket(socket.AF_UNIX);s.bind(root+'/writer.sock');s.listen(8)
if s.fileno()!=3:os.dup2(s.fileno(),3)
os.set_inheritable(3,True)
env=dict(os.environ,PATH=root+'/bin:'+os.environ['PATH'],OPENCLAW_CONFIG_PATH=root+'/config.json',CLAWDI_FIRST_WRITER_NONCE='anonymous')
p=subprocess.Popen(['node',root+'/writer.mjs',root+'/sdk.mjs'],pass_fds=(3,),env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 c=socket.socket(socket.AF_UNIX);c.settimeout(8);c.connect(root+'/writer.sock')
 frame=dict(schemaVersion='clawdi.openclawFirstWrite.v1',nonce='anonymous',requestId='request',operations=[dict(kind='provider',input={'reject':True} if mode=='rejected' else {'tenant':'claimed'})])
 raw=json.dumps(frame,separators=(',',':'))
 if mode=='incomplete':c.sendall(b'{');c.close()
 elif mode=='oversized':
  try:c.sendall(b'x'*(1024*1024+1));c.shutdown(socket.SHUT_WR);c.recv(4096)
  except (BrokenPipeError,ConnectionResetError):pass
  c.close()
 else:
  c.sendall((raw+'\\n').encode());ack=json.loads(c.makefile().readline());c.close()
  assert ack['requestId']=='request' and ack['requestHash']==hashlib.sha256(raw.encode()).hexdigest()
  assert ack['ok']==(mode=='success')
 time.sleep(.1)
 second=socket.socket(socket.AF_UNIX);second.settimeout(5);second.connect(root+'/writer.sock')
 try:
  second.sendall((raw+'\\n').encode());assert not second.recv(4096)
 except ConnectionResetError:pass
 finally:second.close()
 config=json.load(open(root+'/config.json'))
 assert config==({'native':'preserved','tenant':'claimed'} if mode=='success' else {'native':'preserved'})
 print('verified')
finally:
 p.terminate()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait()
 s.close()
`;
		const result = await promisify(execFile)("python3", ["-c", python, scratch, mode], {
			timeout: 20_000,
		});
		expect(result.stdout.trim()).toBe("verified");
	},
	30_000,
);

test("writer source attestation detects restored content, dependencies and symlink targets", () => {
	scratch = mkdtempSync(join(tmpdir(), "writer-source-revision-"));
	const sdk = join(scratch, "sdk");
	mkdirSync(sdk);
	writeFileSync(join(sdk, "package.json"), "{}");
	const entry = join(sdk, "mutation.mjs");
	writeFileSync(entry, "export const value = 1;");
	const original = statSync(entry);
	const initial = openClawWriterSourceRevision(entry);
	writeFileSync(entry, "export const value = 2;");
	writeFileSync(entry, "export const value = 1;");
	utimesSync(entry, original.atime, original.mtime);
	expect(openClawWriterSourceRevision(entry)).not.toBe(initial);

	const dependencies = join(sdk, "node_modules");
	mkdirSync(dependencies);
	const external = join(scratch, "external.mjs");
	writeFileSync(external, "export const dependency = 1;");
	symlinkSync(external, join(dependencies, "dependency.mjs"));
	const linked = openClawWriterSourceRevision(entry);
	writeFileSync(external, "export const dependency = 2;");
	expect(openClawWriterSourceRevision(entry)).not.toBe(linked);
	const changed = openClawWriterSourceRevision(entry);
	rmSync(join(dependencies, "dependency.mjs"));
	symlinkSync(entry, join(dependencies, "dependency.mjs"));
	expect(openClawWriterSourceRevision(entry)).not.toBe(changed);
});

test("OpenClaw warm rejects a supplied context or submitted write before service actions", async () => {
	scratch = mkdtempSync(join(tmpdir(), "first-writer-warm-safety-"));
	const paths = {
		...getRuntimePaths({ mode: "hosted" }),
		runRoot: scratch,
		statusRoot: scratch,
		runtimeContextFile: join(scratch, "context.json"),
		appliedState: join(scratch, "applied.json"),
		manifestLastGood: join(scratch, "last-good.json"),
		managedSecretCacheFile: join(scratch, "secrets.json"),
	};
	writeFileSync(paths.runtimeContextFile, "{}");
	await expect(warmHostedOpenClawRuntime(paths)).rejects.toThrow("unclaimed runtime");
	rmSync(paths.runtimeContextFile);
	writeFileSync(firstWriterPaths(paths).used, "submitted\n", { mode: 0o600 });
	await expect(warmHostedOpenClawRuntime(paths)).rejects.toThrow("submitted tenant config write");
});

test.skipIf(process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1")(
	"native writer socket notifies readiness, enforces UID isolation, and consumes one batch",
	() => {
		scratch = mkdtempSync(join(tmpdir(), "native-first-writer-"));
		chmodSync(scratch, 0o755);
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = join(scratch, "home");
		process.env.CLAWDI_SERVICE_STATE_DIR = join(scratch, "state");
		process.env.CLAWDI_RUN_DIR = join(scratch, "run");
		process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = "/etc/systemd/system";
		const paths = getRuntimePaths();
		const sdk = join(scratch, "sdk");
		mkdirSync(sdk, { mode: 0o755 });
		mkdirSync(paths.userHome, { mode: 0o755 });
		chownSync(paths.userHome, 10001, 10001);
		mkdirSync(join(paths.userHome, ".openclaw"), { mode: 0o700 });
		chownSync(join(paths.userHome, ".openclaw"), 10001, 10001);
		mkdirSync(paths.statusRoot, { recursive: true });
		mkdirSync(paths.runRoot, { mode: 0o711 });
		const config = join(paths.userHome, ".openclaw", "openclaw.json");
		writeFileSync(config, '{"unrelated":"preserved"}', { mode: 0o600 });
		chownSync(config, 10001, 10001);
		writeFileSync(join(sdk, "package.json"), '{"type":"module"}');
		const entry = join(sdk, "mutation.mjs");
		writeFileSync(
			entry,
			`
 import {readFileSync,writeFileSync} from "node:fs";
 const path=process.env.OPENCLAW_CONFIG_PATH;
 export async function readConfigFileSnapshotForWrite(){
  if(process.getuid()!==10001)throw new Error("wrong writer UID");
  return {snapshot:{valid:true,sourceConfig:JSON.parse(readFileSync(path,"utf8"))}};
 }
 export async function mutateConfigFile(options){
  if(options.base!=="source"||options.afterWrite.mode!=="auto")throw new Error("wrong native mutation");
  const config=JSON.parse(readFileSync(path,"utf8"));options.mutate(config);
  writeFileSync(path,JSON.stringify(config));
 }
 `,
		);
		const units = ["openclaw-first-writer.socket", "openclaw-first-writer.service"];
		const policy = join(paths.systemdSystemRoot, units[1] + ".d", "10-fixture-policy.conf");
		mkdirSync(dirname(policy), { recursive: true });
		writeFileSync(policy, "[Service]\nUser=0\n");

		try {
			expect(() => warmFirstOpenClawWriter(paths, entry, 10001, 10001)).toThrow(
				"refuses overridden units",
			);
			writeFileSync(
				policy,
				"[Service]\nTimeoutStopFailureMode=abort\nProcSubset=all\nProtectProc=default\nProtectControlGroups=no\nProtectKernelTunables=no\nNoNewPrivileges=no\nLoadCredential=\nPrivateNetwork=no\nImportCredential=\n",
			);
			warmFirstOpenClawWriter(paths, entry, 10001, 10001);
			const denied = spawnSync(
				"runuser",
				[
					"-u",
					"clawdi",
					"--",
					"node",
					"--input-type=module",
					"--eval",
					'import {createConnection} from "node:net"; const c=createConnection(process.argv[1]); c.on("error",e=>process.exit(e.code==="EACCES"?0:1)); c.on("connect",()=>process.exit(1));',
					firstWriterPaths(paths).socket,
				],
				{ timeout: 5000 },
			);
			expect(denied.status).toBe(0);
			process.env.CLAWDI_RUNTIME_USER = "clawdi";
			const context = createOpenClawHostedContextForHome(paths.userHome, false);
			context.sdk.configMutation = entry;
			withRuntimeUserFileAccess(
				() => {
					beginOpenClawConfigTransaction(context, {});
					applyOpenClawContextMergePatch(context, { tenant: "claimed" }, paths.userHome);
				},
				{ uid: 10001, gid: 10001 },
			);
			commitOpenClawConfigTransaction(context, paths.userHome);
			expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
				unrelated: "preserved",
				tenant: "claimed",
			});
			expect(existsSync(firstWriterPaths(paths).socket)).toBe(false);
			expect(existsSync(firstWriterPaths(paths).receipt)).toBe(false);
			expect(existsSync(firstWriterPaths(paths).used)).toBe(true);
			expect(
				tryFirstOpenClawWrite(entry, paths.userHome, [
					{ kind: "provider", input: { tenant: "replayed" } },
				]),
			).toBe(false);
		} catch (error) {
			const journal = spawnSync(
				"journalctl",
				["-u", units[1], "--no-pager", "-o", "cat", "-n", "60"],
				{ encoding: "utf8" },
			);
			console.error(journal.stdout);
			console.error(
				spawnSync("systemctl", ["cat", "--no-pager", ...units], { encoding: "utf8" }).stdout,
			);
			throw error;
		} finally {
			spawnSync("systemctl", ["stop", ...units], { timeout: 10_000 });
			rmSync(dirname(policy), { recursive: true, force: true });
			for (const unit of units) rmSync(join(paths.systemdSystemRoot, unit), { force: true });
			spawnSync("systemctl", ["daemon-reload"], { timeout: 10_000 });
		}
	},
	15_000,
);
