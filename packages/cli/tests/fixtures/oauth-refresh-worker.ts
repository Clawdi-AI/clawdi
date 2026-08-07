import { getClawdiAccessToken } from "../../src/lib/clerk-oauth";

await getClawdiAccessToken("https://cloud.example.test");
process.stdout.write("ok\n");
