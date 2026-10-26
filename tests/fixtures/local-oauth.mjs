import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { localKey, SecureStore } from "../../local/storage.mjs";
import { ChatGPT } from "../../local/chatgpt.mjs";
const keys = generateKeyPair("RS256");
export async function oauthFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "laras-oauth-"));
  const store = new SecureStore(directory, await localKey(directory));
  await store.initialize();
  const { publicKey, privateKey } = await keys;
  const jwk = { ...(await exportJWK(publicKey)), kid: "fixture", alg: "RS256" };
  const f = {
    directory,
    store,
    calls: [],
    subject: "subject-a",
    nonce: null,
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    refreshCount: 0,
    tokenCount: 0,
    revokeStatus: 200,
    responseComplete: true,
    tokenStatus: 200,
  };
  f.fetcher = async (url, options = {}) => {
    url = String(url);
    f.calls.push({ url, options });
    if (url.endsWith("openid-configuration"))
      return Response.json({
        issuer: "https://auth.openai.com",
        authorization_endpoint:
          "https://auth.openai.com/api/accounts/authorize",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
        revocation_endpoint:
          "https://auth.openai.com/api/accounts/oauth/revoke",
      });
    if (url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/oauth/token")) {
      if (f.tokenStatus !== 200)
        return new Response("provider-secret-detail", {
          status: f.tokenStatus,
        });
      const values = new URLSearchParams(options.body);
      const refresh = values.get("grant_type") === "refresh_token";
      if (refresh) f.refreshCount++;
      const idToken = refresh
        ? undefined
        : await new SignJWT({
            nonce: f.badNonce ? "wrong-nonce" : f.nonce,
            email: "fixture@example.test",
          })
            .setProtectedHeader({ alg: "RS256", kid: "fixture" })
            .setIssuer("https://auth.openai.com")
            .setAudience(
              f.badAudience ? "wrong-client" : values.get("client_id"),
            )
            .setSubject(f.subject)
            .setIssuedAt()
            .setExpirationTime(f.expiredToken ? "-1h" : "1h")
            .sign(privateKey);
      f.tokenCount++;
      return Response.json({
        access_token: "ACCESS_SECRET_" + f.tokenCount,
        refresh_token: "REFRESH_SECRET_" + f.tokenCount,
        id_token: idToken,
        scope: f.scope,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (url.endsWith("/oauth/revoke"))
      return new Response(null, { status: f.revokeStatus });
    if (url.endsWith("/v1/models"))
      return Response.json({
        models: [
          {
            slug: "fixture-model",
            display_name: "Fixture Model",
            visibility: "list",
          },
          { slug: "hidden-model", display_name: "Hidden", visibility: "hide" },
        ],
      });
    if (url.endsWith("/v1/responses")) {
      const text = JSON.stringify({
        title: "SOP",
        lines: ["Hubungi supervisor."],
        sourceIds: ["E0"],
      });
      const events = [
        { type: "response.output_text.delta", delta: text },
        ...(f.responseComplete
          ? [{ type: "response.completed", response: { status: "completed" } }]
          : []),
      ];
      return new Response(
        events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    throw new Error("Unexpected fixture URL");
  };
  f.oauth = new ChatGPT({
    store,
    callbackURL: "http://127.0.0.1:3000/auth/callback",
    fetcher: f.fetcher,
  });
  f.login = async ({
    newAccount = false,
    client = "oaiapp_fixture_a",
  } = {}) => {
    const result = await f.oauth.begin({ newAccount });
    const url = new URL(result.authorizationURL);
    f.nonce = url.searchParams.get("nonce");
    await f.oauth.callback(
      new URLSearchParams({
        state: url.searchParams.get("state"),
        code: "fixture-code",
        client_id: client,
      }),
    );
    return url;
  };
  f.close = () => rm(directory, { recursive: true, force: true });
  return f;
}
