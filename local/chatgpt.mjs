import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
import { AppError } from "../server/http.js";
import { completedText, responseError } from "./responses.mjs";
const ISSUER = "https://auth.openai.com",
  RESOURCE = "https://api.openai.com/v1";
const SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const sharing = (p) =>
  p?.scopes?.includes("chatgpt.tokens.use.direct") &&
  p.scopes.includes("resource.invoke");
const active = (data) => data.profiles.find((p) => p.id === data.selected);
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const secureEndpoint = (value) => {
  const u = new URL(value);
  if (u.origin !== ISSUER || u.username || u.password)
    throw new Error("Invalid OpenAI discovery endpoint");
  return u.href;
};

export class ChatGPT {
  constructor({
    store,
    callbackURL,
    fetcher = fetch,
    verifyIdentity,
    now = () => Date.now(),
  }) {
    this.store = store;
    this.callbackURL = callbackURL;
    this.fetcher = fetcher;
    this.now = now;
    this.pending = null;
    this.notice = null;
    this.discoveryCache = null;
    this.jwks = null;
    this.verifyIdentity = verifyIdentity;
    this.controllers = new Set();
  }
  async discovery() {
    if (!this.discoveryCache) {
      const r = await this.fetcher(
        ISSUER + "/.well-known/openid-configuration",
        { signal: AbortSignal.timeout(15000), redirect: "error" },
      );
      if (!r.ok)
        throw new AppError(
          503,
          "CHATGPT_DISCOVERY_FAILED",
          "Konfigurasi login ChatGPT belum dapat dihubungi.",
        );
      const d = await r.json();
      if (d.issuer !== ISSUER) throw new Error("Unexpected OpenAI issuer");
      for (const key of [
        "authorization_endpoint",
        "token_endpoint",
        "jwks_uri",
        "revocation_endpoint",
      ])
        if (d[key]) d[key] = secureEndpoint(d[key]);
      if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri)
        throw new Error("Incomplete OpenAI discovery");
      this.discoveryCache = d;
    }
    return this.discoveryCache;
  }
  async tokenRequest(values) {
    const d = await this.discovery();
    const response = await this.fetcher(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...values, resource: RESOURCE }),
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        response.status === 400 || response.status === 401 ? 401 : 503,
        "CHATGPT_RECONNECT_REQUIRED",
        "Sesi ChatGPT perlu dihubungkan kembali. Klik Continue with ChatGPT.",
      );
    }
    const data = await response.json();
    if (
      typeof data.access_token !== "string" ||
      data.access_token.length > 30000
    )
      throw new AppError(
        502,
        "CHATGPT_TOKEN_INVALID",
        "Respons login ChatGPT tidak valid.",
      );
    return data;
  }
  async begin({ profileId, newAccount = false } = {}) {
    const d = await this.discovery();
    const data = await this.store.read();
    const profile = newAccount
      ? null
      : data.profiles.find((p) => p.id === (profileId || data.selected));
    if (profileId && !profile)
      throw new AppError(
        404,
        "CHATGPT_ACCOUNT_NOT_FOUND",
        "Akun ChatGPT tidak ditemukan.",
      );
    const verifier = randomBytes(48).toString("base64url"),
      state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    this.pending = {
      state,
      nonce,
      verifier,
      clientId: profile?.clientId || null,
      profileId: profile?.id || null,
      subject: profile?.subject || null,
      expires: this.now() + 10 * 60000,
    };
    const url = new URL(d.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: profile?.clientId || "dynamic_agent_client",
      ext_agent_host_id: data.hostId,
      response_type: "code",
      redirect_uri: this.callbackURL,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }))
      url.searchParams.set(key, value);
    if (!profile) url.searchParams.set("agent_name_hint", "Laras");
    else {
      if (profile.tokens?.idToken)
        url.searchParams.set("id_token_hint", profile.tokens.idToken);
      else if (profile.email) url.searchParams.set("login_hint", profile.email);
      if (!sharing(profile)) url.searchParams.set("prompt", "consent");
    }
    this.notice = null;
    return { authorizationURL: url.href };
  }
  async callback(params) {
    const pending = this.pending;
    if (
      !pending ||
      pending.expires < this.now() ||
      !same(params.get("state"), pending.state)
    )
      throw new AppError(
        400,
        "CHATGPT_STATE_INVALID",
        "Sesi login tidak cocok atau kedaluwarsa. Mulai login kembali.",
      );
    this.pending = null;
    if (params.has("error"))
      throw new AppError(
        400,
        "CHATGPT_CONSENT_DENIED",
        "Login atau izin penggunaan paket ChatGPT dibatalkan.",
      );
    const issued = params.get("client_id") || pending.clientId,
      code = params.get("code");
    if (
      !issued ||
      issued === "dynamic_agent_client" ||
      issued.length > 250 ||
      !code ||
      code.length > 5000 ||
      (pending.clientId && pending.clientId !== issued)
    )
      throw new AppError(
        400,
        "CHATGPT_CALLBACK_INVALID",
        "Hasil pendaftaran ChatGPT tidak cocok. Mulai login kembali.",
      );
    return this.store.run(async () => {
      const data = await this.store.read();
      let profile = data.profiles.find((p) => p.id === pending.profileId);
      if (!profile) {
        profile = { id: randomUUID(), clientId: issued };
        data.profiles.push(profile);
      }
      profile.clientId = issued;
      // Retain an issued registration even if the authorization code expires.
      await this.store.write(data);
      const token = await this.tokenRequest({
        grant_type: "authorization_code",
        client_id: issued,
        code,
        code_verifier: pending.verifier,
        redirect_uri: this.callbackURL,
      });
      const d = await this.discovery();
      let claims;
      if (this.verifyIdentity)
        claims = await this.verifyIdentity(token.id_token, {
          issuer: ISSUER,
          audience: issued,
          nonce: pending.nonce,
        });
      else {
        this.jwks ||= createRemoteJWKSet(new URL(d.jwks_uri), {
          [customFetch]: this.fetcher,
        });
        try {
          claims = (
            await jwtVerify(token.id_token, this.jwks, {
              issuer: ISSUER,
              audience: issued,
              requiredClaims: ["sub", "exp", "nonce"],
              clockTolerance: 30,
            })
          ).payload;
        } catch {
          throw new AppError(
            401,
            "CHATGPT_IDENTITY_INVALID",
            "Identitas login ChatGPT tidak dapat diverifikasi.",
          );
        }
      }
      if (
        !claims?.sub ||
        !same(claims.nonce, pending.nonce) ||
        (pending.subject && claims.sub !== pending.subject)
      )
        throw new AppError(
          401,
          "CHATGPT_IDENTITY_MISMATCH",
          "Akun login tidak cocok dengan koneksi yang dipilih.",
        );
      profile.issuer = ISSUER;
      profile.subject = claims.sub;
      profile.email = typeof claims.email === "string" ? claims.email : null;
      profile.scopes = String(token.scope || "")
        .split(/\s+/)
        .filter(Boolean);
      profile.tokens = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || null,
        idToken: token.id_token,
        expiresAt:
          this.now() + Math.max(0, Number(token.expires_in) || 0) * 1000,
      };
      profile.verifiedAt = null;
      data.selected = profile.id;
      await this.store.write(data);
      this.notice = sharing(profile)
        ? "Akun terhubung. Pilih model lalu ajukan pertanyaan untuk menguji akses AI."
        : "Akun terhubung, tetapi izin penggunaan paket ChatGPT belum diberikan.";
      return this.publicProfile(profile);
    });
  }
  publicProfile(profile) {
    return profile
      ? {
          id: profile.id,
          email: profile.email || "Akun ChatGPT",
          connected: !!profile.tokens?.accessToken,
          sharing: sharing(profile),
          model: profile.model || null,
          verifiedAt: profile.verifiedAt || null,
        }
      : null;
  }
  async status() {
    const data = await this.store.read();
    return {
      available: true,
      account: this.publicProfile(active(data)),
      accounts: data.profiles.map((p) => this.publicProfile(p)),
      notice: this.notice,
      manageUsageURL: "https://chatgpt.com/#settings/Usage",
    };
  }
  async access() {
    return this.store.run(async () => {
      const data = await this.store.read(),
        profile = active(data);
      if (!profile?.tokens?.accessToken)
        throw new AppError(
          401,
          "CHATGPT_LOGIN_REQUIRED",
          "Hubungkan akun melalui Continue with ChatGPT.",
        );
      if (!sharing(profile))
        throw new AppError(
          403,
          "CHATGPT_PLAN_PERMISSION_REQUIRED",
          "Berikan izin penggunaan paket ChatGPT saat login.",
        );
      if (profile.tokens.expiresAt < this.now() + 60000) {
        if (!profile.tokens.refreshToken)
          throw new AppError(
            401,
            "CHATGPT_RECONNECT_REQUIRED",
            "Sesi ChatGPT kedaluwarsa. Hubungkan kembali akun.",
          );
        let token;
        try {
          token = await this.tokenRequest({
            grant_type: "refresh_token",
            client_id: profile.clientId,
            refresh_token: profile.tokens.refreshToken,
          });
        } catch (error) {
          if (error.status === 401) {
            delete profile.tokens;
            profile.scopes = [];
            profile.verifiedAt = null;
            await this.store.write(data);
          }
          throw error;
        }
        profile.tokens = {
          accessToken: token.access_token,
          refreshToken: token.refresh_token || profile.tokens.refreshToken,
          idToken: token.id_token || profile.tokens.idToken,
          expiresAt:
            this.now() + Math.max(0, Number(token.expires_in) || 0) * 1000,
        };
        if (token.scope) profile.scopes = String(token.scope).split(/\s+/);
        await this.store.write(data);
        if (!sharing(profile))
          throw new AppError(
            403,
            "CHATGPT_PLAN_PERMISSION_REQUIRED",
            "Izin penggunaan paket ChatGPT perlu diberikan kembali.",
          );
      }
      return {
        id: profile.id,
        token: profile.tokens.accessToken,
        model: profile.model,
      };
    });
  }
  async catalog() {
    const access = await this.access();
    const r = await this.fetcher(RESOURCE + "/models", {
      headers: { authorization: "Bearer " + access.token },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw responseError();
    }
    const data = await r.json();
    if (!Array.isArray(data.models))
      throw new AppError(
        502,
        "CHATGPT_MODELS_INVALID",
        "Daftar model ChatGPT tidak valid.",
      );
    return {
      profileId: access.id,
      models: data.models
        .filter(
          (m) =>
            m.visibility === "list" &&
            typeof m.slug === "string" &&
            m.slug.length < 200,
        )
        .map((m) => ({
          slug: m.slug,
          name: typeof m.display_name === "string" ? m.display_name : m.slug,
        })),
    };
  }
  async models() {
    return (await this.catalog()).models;
  }
  async choose(model) {
    const { models, profileId } = await this.catalog();
    if (!models.some((m) => m.slug === model))
      throw new AppError(
        422,
        "CHATGPT_MODEL_INVALID",
        "Pilih model yang tersedia untuk akun ChatGPT ini.",
      );
    return this.store.run(async () => {
      const data = await this.store.read();
      if (data.selected !== profileId)
        throw new AppError(
          409,
          "CHATGPT_ACCOUNT_CHANGED",
          "Akun berubah. Muat ulang daftar model.",
        );
      active(data).model = model;
      active(data).verifiedAt = null;
      await this.store.write(data);
      return this.publicProfile(active(data));
    });
  }
  async select(id) {
    return this.store.run(async () => {
      const data = await this.store.read();
      if (!data.profiles.some((p) => p.id === id))
        throw new AppError(
          404,
          "CHATGPT_ACCOUNT_NOT_FOUND",
          "Akun tidak ditemukan.",
        );
      data.selected = id;
      await this.store.write(data);
      return this.publicProfile(active(data));
    });
  }
  async disconnect() {
    this.pending = null;
    for (const controller of this.controllers) controller.abort();
    return this.store.run(async () => {
      const data = await this.store.read(),
        profile = active(data);
      let revoked = !profile?.tokens?.refreshToken;
      if (profile?.tokens?.refreshToken)
        try {
          const d = await this.discovery();
          if (d.revocation_endpoint) {
            const r = await this.fetcher(d.revocation_endpoint, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: profile.tokens.refreshToken,
                token_type_hint: "refresh_token",
                client_id: profile.clientId,
              }),
              signal: AbortSignal.timeout(10000),
              redirect: "error",
            });
            revoked = r.ok;
            await r.body?.cancel();
          }
        } catch {}
      if (profile) {
        delete profile.tokens;
        profile.scopes = [];
        profile.verifiedAt = null;
        await this.store.write(data);
      }
      this.notice = revoked
        ? "Koneksi ChatGPT diputuskan."
        : "Koneksi lokal diputuskan. Pencabutan sesi di OpenAI belum terkonfirmasi; kelola akses melalui ChatGPT Settings.";
      return { disconnected: true, revoked };
    });
  }
  async generate({ instructions, input, signal }) {
    const access = await this.access();
    if (!access.model)
      throw new AppError(
        422,
        "CHATGPT_MODEL_REQUIRED",
        "Pilih model di pengaturan ChatGPT terlebih dahulu.",
      );
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const r = await this.fetcher(RESOURCE + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer " + access.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: access.model,
          instructions,
          input: [{ role: "user", content: input }],
          store: false,
          stream: true,
        }),
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
        redirect: "error",
      });
      if (!r.ok) {
        let code;
        try {
          code = (await r.json()).error?.code;
        } catch {}
        throw responseError(code);
      }
      const text = await completedText(r);
      await this.store.run(async () => {
        const data = await this.store.read();
        const p = active(data);
        if (p?.id === access.id && p.tokens?.accessToken === access.token) {
          p.verifiedAt = new Date(this.now()).toISOString();
          await this.store.write(data);
        }
      });
      return { choices: [{ message: { content: text } }] };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
}
