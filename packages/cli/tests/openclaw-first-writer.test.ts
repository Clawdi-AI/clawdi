import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	assertFirstWriterUnclaimed,
	FIRST_WRITER_SCRIPT,
	firstWriterPaths,
} from "../src/runtime/openclaw-first-writer";
import { getRuntimePaths } from "../src/runtime/paths";
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
  if(options.skipPluginValidation!==true)throw new Error("bad preview");
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
