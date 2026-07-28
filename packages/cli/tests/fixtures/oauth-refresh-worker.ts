import { getClawdiAccessToken } from "../../src/lib/clerk-oauth";

await getClawdiAccessToken();
process.stdout.write("ok\n");
