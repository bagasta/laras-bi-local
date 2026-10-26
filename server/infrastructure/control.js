import { AppError } from "../http.js";

const encode = (bytes) => {
  let value = "";
  for (let index = 0; index < bytes.length; index += 16384)
    value += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return btoa(value);
};
const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
async function encryptionKey(env) {
  try {
    const raw = decode(env.LARAS_ENCRYPTION_KEY || "");
    if (raw.length !== 32) throw new Error();
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    throw new AppError(
      503,
      "ENCRYPTION_NOT_CONFIGURED",
      "Penyimpanan koneksi belum siap.",
    );
  }
}
export async function sealToken(token, owner, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(owner) },
    key,
    new TextEncoder().encode(token),
  );
  return encode(iv) + "." + encode(new Uint8Array(encrypted));
}
export async function openToken(value, owner, env) {
  try {
    const [iv, cipher] = value.split(".");
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decode(iv),
          additionalData: new TextEncoder().encode(owner),
        },
        await encryptionKey(env),
        decode(cipher),
      ),
    );
  } catch {
    throw new AppError(
      503,
      "CONNECTION_UNREADABLE",
      "Koneksi tersimpan tidak dapat dibuka. Hubungkan kembali Supabase.",
    );
  }
}
export class ControlStore {
  constructor(db) {
    if (!db)
      throw new AppError(
        503,
        "CONTROL_NOT_READY",
        "Penyimpanan koneksi belum siap.",
      );
    this.db = db;
  }
  async connection(owner) {
    return this.db
      .prepare("SELECT * FROM cloud_connections WHERE owner_id=?")
      .bind(owner)
      .first();
  }
  async job(owner) {
    return this.db
      .prepare("SELECT * FROM provisioning_jobs WHERE owner_id=?")
      .bind(owner)
      .first();
  }
  async aiConnection(owner) {
    return this.db
      .prepare("SELECT * FROM ai_connections WHERE owner_id=?")
      .bind(owner)
      .first();
  }
  async saveAIConnection(owner, encryptedKey, model) {
    await this.db
      .prepare(
        "INSERT INTO ai_connections(owner_id,encrypted_key,model,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET encrypted_key=excluded.encrypted_key,model=excluded.model,updated_at=excluded.updated_at",
      )
      .bind(owner, encryptedKey, model, Date.now())
      .run();
  }
  async removeAIConnection(owner) {
    await this.db
      .prepare("DELETE FROM ai_connections WHERE owner_id=?")
      .bind(owner)
      .run();
  }
  async saveConnection(owner, values) {
    const previous = await this.connection(owner);
    const changed =
      previous &&
      (previous.organization !== values.organization ||
        previous.project_name !== values.projectName);
    const saved = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO cloud_connections(owner_id,encrypted_token,organization,project_name,project_ref,updated_at)
        SELECT ?,?,?,?,NULL,? WHERE NOT EXISTS(SELECT 1 FROM provisioning_jobs WHERE owner_id=? AND (lease_until>? OR(create_attempted=1 AND phase<>'ready')))
        OR EXISTS(SELECT 1 FROM cloud_connections WHERE owner_id=? AND organization=? AND project_name=?)
        ON CONFLICT(owner_id) DO UPDATE SET encrypted_token=excluded.encrypted_token,
        project_ref=CASE WHEN cloud_connections.organization=excluded.organization AND cloud_connections.project_name=excluded.project_name THEN cloud_connections.project_ref ELSE NULL END,
        organization=excluded.organization,project_name=excluded.project_name,updated_at=excluded.updated_at`,
        )
        .bind(
          owner,
          values.encryptedToken,
          values.organization,
          values.projectName,
          Date.now(),
          owner,
          Date.now(),
          owner,
          values.organization,
          values.projectName,
        ),
      ...(changed
        ? [
            this.db
              .prepare(
                `DELETE FROM provisioning_jobs WHERE owner_id=? AND lease_until<=? AND(create_attempted=0 OR phase='ready')
        AND EXISTS(SELECT 1 FROM cloud_connections WHERE owner_id=? AND organization=? AND project_name=?)`,
              )
              .bind(
                owner,
                Date.now(),
                owner,
                values.organization,
                values.projectName,
              ),
          ]
        : []),
    ]);
    if (saved[0].meta.changes !== 1)
      throw new AppError(
        409,
        "PROVISIONING_ACTIVE",
        "Penyiapan sedang berjalan. Tujuan proyek belum dapat diganti.",
      );
  }
  async ensureJob(owner) {
    await this.db
      .prepare(
        "INSERT INTO provisioning_jobs(owner_id,updated_at) VALUES(?,?) ON CONFLICT(owner_id) DO NOTHING",
      )
      .bind(owner, Date.now())
      .run();
  }
  async lease(owner) {
    const token = crypto.randomUUID();
    const result = await this.db
      .prepare(
        "UPDATE provisioning_jobs SET lease_owner=?,lease_until=? WHERE owner_id=? AND lease_until<? RETURNING *",
      )
      .bind(token, Date.now() + 120000, owner, Date.now())
      .first();
    return result ? { ...result, lease_owner: token } : null;
  }
  async update(owner, lease, patch) {
    const fields = {
      phase: "phase",
      projectRef: "project_ref",
      createAttempted: "create_attempted",
      errorCode: "error_code",
      schemaHash: "schema_hash",
    };
    const entries = Object.entries(patch);
    if (entries.some(([key]) => !fields[key]))
      throw new Error("Invalid provisioning field");
    const result = await this.db
      .prepare(
        `UPDATE provisioning_jobs SET ${entries.map(([k]) => fields[k] + "=?").join(",")},updated_at=? WHERE owner_id=? AND lease_owner=?`,
      )
      .bind(...entries.map(([, v]) => v), Date.now(), owner, lease)
      .run();
    if (result.meta.changes !== 1)
      throw new AppError(
        409,
        "LEASE_LOST",
        "Penyiapan sedang dilanjutkan oleh permintaan lain.",
      );
    return result;
  }
  async release(owner, lease) {
    await this.db
      .prepare(
        "UPDATE provisioning_jobs SET lease_until=0,lease_owner=NULL WHERE owner_id=? AND lease_owner=?",
      )
      .bind(owner, lease)
      .run();
  }
  async rememberProject(owner, ref) {
    await this.db
      .prepare(
        "UPDATE cloud_connections SET project_ref=?,updated_at=? WHERE owner_id=?",
      )
      .bind(ref, Date.now(), owner)
      .run();
  }
}
export async function ownerEnvironment(
  env,
  owner,
  store,
  { includeAI = true } = {},
) {
  if (!env.DB && !store) return env;
  const control = store || new ControlStore(env.DB);
  const [record, ai] = await Promise.all([
    control.connection(owner),
    control.aiConnection?.(owner),
  ]);
  const databaseEnv = record
    ? {
        ...env,
        SUPABASE_URL: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
        SUPABASE_ACCESS_TOKEN: await openToken(
          record.encrypted_token,
          owner,
          env,
        ),
        SUPABASE_ORGANIZATION_ID: record.organization,
        SUPABASE_PROJECT_NAME: record.project_name,
        SUPABASE_PROJECT_REF: record.project_ref || undefined,
      }
    : env;
  if (!ai) return databaseEnv;
  let key;
  if (includeAI) {
    try {
      key = await openToken(ai.encrypted_key, owner + "|openrouter", env);
    } catch {
      throw new AppError(
        503,
        "AI_CONNECTION_UNREADABLE",
        "Koneksi OpenRouter tersimpan tidak dapat dibuka. Hubungkan kembali OpenRouter.",
      );
    }
  }
  return {
    ...databaseEnv,
    OPENROUTER_API_KEY: key,
    OPENROUTER_MODEL: ai.model,
    LARAS_AI_CONFIGURED: true,
    LARAS_AI_SOURCE: "owner",
  };
}
