import { upstream } from "./server/infrastructure/upstream.js";
import { management } from "./server/infrastructure/supabase.js";

function check(condition, label) {
  if (!condition) throw new Error(label);
}
async function rejects(operation, code) {
  try {
    await operation();
  } catch (error) {
    check(error.code === code, `${code}: ${error.code}`);
    return;
  }
  throw new Error(`Expected ${code}`);
}
export default {
  async test(_ctrl, env) {
    let oldModeRejected = false;
    try {
      new Request("https://api.supabase.com/v1/organizations/org", {
        redirect: "error",
      });
    } catch {
      oldModeRejected = true;
    }
    check(
      oldModeRejected,
      "Regression no longer represents the Workers redirect incompatibility",
    );
    const fetcher = (url, options) => env.PROVIDER.fetch(url, options);
    const data = await management(
      { SUPABASE_ACCESS_TOKEN: "fixture-token" },
      "/organizations/org",
      {},
      fetcher,
    );
    check(data.plan === "free", "Successful organization validation");
    await rejects(
      () =>
        management(
          { SUPABASE_ACCESS_TOKEN: "wrong" },
          "/organizations/org",
          {},
          fetcher,
        ),
      "SUPABASE_TOKEN_INVALID",
    );
    await rejects(
      () =>
        management(
          { SUPABASE_ACCESS_TOKEN: "fixture-token" },
          "/organizations/missing",
          {},
          fetcher,
        ),
      "SUPABASE_RESOURCE_NOT_FOUND",
    );
    await rejects(
      () => upstream(fetcher, "https://api.supabase.com/v1/redirect"),
      "UPSTREAM_REDIRECT",
    );
    console.log(
      "Workers runtime: original failure reproduced; organization validation and safe redirect handling passed.",
    );
  },
};
