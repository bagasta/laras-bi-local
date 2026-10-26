import {
  AppError,
  json,
  readJson,
  identity,
  integer,
  text,
  uuid,
  sha256,
} from "./http.js";
import { configuration } from "./config.js";
import {
  createRepository,
  management,
  resolveProject,
} from "./infrastructure/supabase.js";
import { prepareImport } from "./domain/imports.js";
import { validateCatalog } from "./domain/catalog.js";
import { deriveInsights } from "./domain/insights.js";
import { ControlStore, ownerEnvironment } from "./infrastructure/control.js";
import { saveAIConnection, aiStatus } from "./infrastructure/openrouter.js";
import {
  advanceProvisioning,
  saveCloudConnection,
  listCloudOrganizations,
  publicJob,
} from "./services/cloud-setup.js";
import {
  extractDocument,
  documentSummary,
  prepareDocumentBatch,
} from "./domain/documents.js";
import { adaptiveFor } from "./services/adaptive-dashboard.js";
import { answerChat } from "./services/chat.js";

const validPreferences = new Set(["daily", "stock", "production"]);
const apiMethods = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

export function createApp({
  assets = {},
  migration = "",
  repositoryFactory = createRepository,
  fetcher = fetch,
  logger = console,
  instanceId = "local",
  controlFactory = (env) => new ControlStore(env.DB),
} = {}) {
  async function snapshot(owner, repository, days, selection = {}) {
    const data = await repository.call(owner, "bootstrap", { days });
    const adaptive = await adaptiveFor(owner, repository, data, selection);
    return {
      ...data,
      datasets: adaptive.datasets,
      adaptiveDashboard: adaptive.model,
      insights: [
        ...(await deriveInsights(data)),
        ...(adaptive.model?.findings || []),
      ],
    };
  }
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      const path = url.pathname;
      const requestId = crypto.randomUUID();
      if (!path.startsWith("/api/")) return serveAsset(request, assets);
      try {
        if (path === "/api/health" && request.method === "GET")
          return json({ status: "ok", version: 1 }, 200, requestId);
        const owner = identity(request, env);
        if (!apiMethods.has(request.method))
          throw new AppError(
            405,
            "METHOD_NOT_ALLOWED",
            "Metode tidak tersedia.",
          );
        const rootEnv = env;
        const control = env.DB ? controlFactory(env) : null;
        if (path === "/api/ai/connection") {
          if (request.method === "GET")
            return json(
              { data: await aiStatus(owner, rootEnv, control), requestId },
              200,
              requestId,
            );
          if (!["POST", "DELETE"].includes(request.method))
            throw new AppError(
              405,
              "METHOD_NOT_ALLOWED",
              "Metode tidak tersedia.",
            );
          if (!control)
            throw new AppError(
              503,
              "CONTROL_NOT_READY",
              "Penyimpanan koneksi belum siap.",
            );
          const body = await readJson(request, 4096);
          if (request.method === "DELETE") {
            await control.removeAIConnection(owner);
            return json(
              { data: await aiStatus(owner, rootEnv, control), requestId },
              200,
              requestId,
            );
          }
          return json(
            {
              data: await saveAIConnection(
                owner,
                body,
                rootEnv,
                fetcher,
                control,
              ),
              requestId,
            },
            200,
            requestId,
          );
        }
        if (path === "/api/cloud/organizations" && request.method === "POST") {
          const body = await readJson(request, 4096);
          const result = await listCloudOrganizations(body, rootEnv, fetcher);
          return json({ data: result, requestId }, 200, requestId);
        }
        if (path === "/api/cloud/connection" && request.method === "POST") {
          if (!control)
            throw new AppError(
              503,
              "CONTROL_NOT_READY",
              "Penyimpanan koneksi belum siap.",
            );
          const body = await readJson(request, 4096);
          const saved = await saveCloudConnection(
            owner,
            body,
            rootEnv,
            fetcher,
            control,
          );
          return json({ data: saved, requestId }, 200, requestId);
        }
        env = await ownerEnvironment(rootEnv, owner, control, {
          includeAI: path === "/api/chat" && !rootEnv.LARAS_CHATGPT_ACTIVE,
        });
        const repository = repositoryFactory(env, fetcher);
        const config = configuration(env);
        const days = () => integer(url.searchParams.get("days"));
        let result,
          status = 200;
        if (path === "/api/status" && request.method === "GET") {
          const job = await control?.job(owner);
          const needsMigration =
            job?.phase === "ready" &&
            migration &&
            job.schema_hash !== (await sha256(migration));
          result = {
            backend: true,
            database: config.database,
            ai: config.ai,
            aiProvider: env.LARAS_CHATGPT_ACTIVE
              ? "chatgpt"
              : config.ai
                ? "openrouter"
                : "rules",
            chatgpt: env.LARAS_CHATGPT_STATUS || null,
            aiConnection: await aiStatus(owner, rootEnv, control),
            mode: config.mode,
            cloud: {
              canConnect: !!rootEnv.DB && !!rootEnv.LARAS_ENCRYPTION_KEY,
              configured: !!env.SUPABASE_ACCESS_TOKEN,
              phase:
                (needsMigration ? "migrating" : job?.phase) ||
                (env.SUPABASE_URL
                  ? "ready"
                  : env.SUPABASE_PROJECT_REF
                    ? "ready"
                    : "pending"),
              projectRef: env.SUPABASE_PROJECT_REF || null,
              projectName:
                env.SUPABASE_PROJECT_NAME ||
                "laras-" + (await sha256(instanceId + owner)).slice(0, 12),
              organization: env.SUPABASE_ORGANIZATION_ID || "",
            },
          };
        } else if (
          path === "/api/cloud/provision" &&
          request.method === "POST"
        ) {
          await readJson(request, 1024);
          if (!control)
            throw new AppError(
              503,
              "CONTROL_NOT_READY",
              "Penyimpanan penyiapan belum siap.",
            );
          result = await advanceProvisioning(
            owner,
            env,
            migration,
            fetcher,
            control,
          );
        } else if (
          path === "/api/documents/extract" &&
          request.method === "POST"
        ) {
          const body = await readJson(request, 2_800_000);
          const doc = await extractDocument(body);
          const staged = await repository.call(owner, "document_stage", {
            ...doc,
            requestKey: text(
              request.headers.get("idempotency-key"),
              "ID permintaan",
              100,
            ),
          });
          result = documentSummary(staged);
          status = 201;
        } else if (
          /^\/api\/documents\/[^/]+$/.test(path) &&
          request.method === "DELETE"
        ) {
          result = await repository.call(owner, "document_remove", {
            id: uuid(path.split("/")[3]),
          });
        } else if (
          /^\/api\/documents\/[^/]+(\/download)?$/.test(path) &&
          request.method === "GET"
        ) {
          const [, id, download] = path.match(
            /^\/api\/documents\/([^/]+)(\/download)?$/,
          );
          uuid(id);
          const doc = await repository.call(owner, "document_get", { id });
          if (download)
            return new Response(
              Uint8Array.from(atob(doc.original), (c) => c.charCodeAt(0)),
              {
                headers: {
                  "content-type":
                    {
                      PDF: "application/pdf",
                      XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                      TXT: "text/plain; charset=utf-8",
                      MD: "text/markdown; charset=utf-8",
                      CSV: "text/csv; charset=utf-8",
                    }[doc.type] || "application/octet-stream",
                  "content-disposition":
                    "attachment; filename*=UTF-8''" +
                    encodeURIComponent(doc.name),
                  "cache-control": "no-store",
                  "x-content-type-options": "nosniff",
                },
              },
            );
          result = documentSummary(doc);
        } else if (
          path === "/api/uploads/preview" &&
          request.method === "POST"
        ) {
          const body = await readJson(request, 100_000);
          if (
            !Array.isArray(body.documents) ||
            body.documents.length < 1 ||
            body.documents.length > 20
          )
            throw new AppError(422, "FILE_LIMIT", "Pilih 1–20 dokumen.");
          const ids = [...new Set(body.documents.map((d) => uuid(d.id)))];
          const stored = await repository.call(owner, "documents_get", { ids });
          const prepared = await prepareDocumentBatch(
            body.documents,
            stored.documents,
          );
          result = await repository.call(owner, "batch_preview", {
            ...prepared,
            requestKey: text(
              request.headers.get("idempotency-key"),
              "ID permintaan",
              100,
            ),
            hash: await sha256(JSON.stringify(body.documents)),
          });
          status = 201;
        } else if (
          /^\/api\/uploads\/[^/]+\/commit$/.test(path) &&
          request.method === "POST"
        ) {
          const id = path.split("/")[3];
          uuid(id);
          const body = await readJson(request, 1024);
          result = await repository.call(owner, "batch_commit", {
            id,
            approved: body.approved,
          });
        } else if (path === "/api/setup" && request.method === "POST") {
          await readJson(request, 1024);
          if (!migration)
            throw new AppError(
              503,
              "MIGRATION_UNAVAILABLE",
              "Migrasi belum tersedia.",
            );
          const ref = await resolveProject(env, fetcher);
          await management(
            env,
            `/projects/${ref}/database/query`,
            { method: "POST", body: JSON.stringify({ query: migration }) },
            fetcher,
          );
          result = { ready: true };
        } else if (path === "/api/workspace" && request.method === "GET") {
          result = await snapshot(
            owner,
            repository,
            days(),
            Object.fromEntries(url.searchParams),
          );
        } else if (
          path === "/api/adaptive-dashboard" &&
          request.method === "GET"
        ) {
          const base = await repository.call(owner, "bootstrap", { days: 21 });
          const adaptive = await adaptiveFor(
            owner,
            repository,
            base,
            Object.fromEntries(url.searchParams),
          );
          result = { ...adaptive.model, datasets: adaptive.datasets };
        } else if (path === "/api/dashboard" && request.method === "GET") {
          result = await repository.call(owner, "dashboard", { days: days() });
        } else if (path === "/api/insights" && request.method === "GET") {
          const data = await snapshot(owner, repository, days());
          result = { findings: data.insights, reviewed: data.reviewed };
        } else if (path === "/api/preferences" && request.method === "PATCH") {
          const body = await readJson(request, 2048);
          const payload = {};
          if (body.name !== undefined)
            payload.name = text(body.name, "Nama bisnis", 80);
          if (body.preferences !== undefined) {
            if (
              !body.preferences ||
              typeof body.preferences !== "object" ||
              Array.isArray(body.preferences) ||
              Object.entries(body.preferences).some(
                ([k, v]) => !validPreferences.has(k) || typeof v !== "boolean",
              )
            )
              throw new AppError(
                422,
                "INVALID_PREFERENCES",
                "Preferensi tidak valid.",
              );
            payload.preferences = body.preferences;
          }
          if (!Object.keys(payload).length)
            throw new AppError(422, "EMPTY_UPDATE", "Tidak ada perubahan.");
          result = await repository.call(owner, "preferences", payload);
        } else if (
          path === "/api/insights/review" &&
          request.method === "POST"
        ) {
          const body = await readJson(request, 1024);
          const data = await snapshot(owner, repository, 21, {
            datasetId: body.datasetId,
          });
          if (
            typeof body.reviewed !== "boolean" ||
            !data.insights.some((i) => i.fingerprint === body.fingerprint)
          )
            throw new AppError(
              409,
              "FINDING_CHANGED",
              "Temuan telah berubah. Muat ulang data.",
            );
          result = await repository.call(owner, "review", {
            fingerprint: body.fingerprint,
            reviewed: body.reviewed,
          });
        } else if (
          path === "/api/imports/preview" &&
          request.method === "POST"
        ) {
          const body = await readJson(request, 2_200_000);
          const prepared = await prepareImport(body);
          if (prepared.errors.length)
            throw new AppError(
              422,
              "VALIDATION_FAILED",
              "Periksa baris yang tidak valid.",
              {
                errors: prepared.errors.slice(0, 50),
                mapping: prepared.mapping,
              },
            );
          const requestKey = text(
            request.headers.get("idempotency-key"),
            "ID permintaan",
            100,
          );
          const { rows, ...metadata } = prepared;
          result = await repository.call(owner, "preview", {
            ...metadata,
            rows: rows.map(({ errors, ...row }) => row),
            requestKey,
          });
          status = 201;
        } else if (
          /^\/api\/imports\/[^/]+\/(commit|rollback)$/.test(path) &&
          request.method === "POST"
        ) {
          const [, id, action] = path.match(
            /^\/api\/imports\/([^/]+)\/(commit|rollback)$/,
          );
          uuid(id);
          const body = await readJson(request, 1024);
          result = await repository.call(owner, action, {
            id,
            approved: body.approved,
          });
        } else if (
          ["/api/inventory", "/api/production"].includes(path) &&
          request.method === "PUT"
        ) {
          const domain = path.split("/").at(-1);
          const body = await readJson(request, 500_000);
          result = await repository.call(
            owner,
            "catalog",
            validateCatalog(body, domain),
          );
        } else if (path === "/api/chat" && request.method === "POST") {
          const body = await readJson(request, 4096);
          body.days = integer(body.days);
          const requestKey = text(
            request.headers.get("idempotency-key"),
            "ID permintaan",
            100,
          );
          const data = await snapshot(owner, repository, body.days, {
            datasetId: body.datasetId,
            adaptiveDays: body.adaptiveDays,
            metricKey: body.metricKey,
            dateKey: body.dateKey,
            groupKey: body.groupKey,
          });
          result = await answerChat({
            body,
            owner,
            requestKey,
            env,
            repository,
            fetcher,
            snapshot: data,
          });
        } else if (path === "/api/chat/history" && request.method === "GET") {
          result = await repository.call(owner, "history");
        } else throw new AppError(404, "NOT_FOUND", "Operasi tidak ditemukan.");
        return json({ data: result, requestId }, status, requestId);
      } catch (error) {
        const known = error instanceof AppError;
        if (!known || error.status >= 500)
          logger.error(
            JSON.stringify({
              event: "api.error",
              requestId,
              path,
              code: known ? error.code : "INTERNAL_ERROR",
              ...(error.upstreamStatus
                ? { upstreamStatus: error.upstreamStatus }
                : {}),
            }),
          );
        return json(
          {
            error: {
              code: known ? error.code : "INTERNAL_ERROR",
              message: known
                ? error.message
                : "Permintaan belum dapat diproses.",
              ...(known && error.details ? { details: error.details } : {}),
            },
            requestId,
          },
          known ? error.status : 500,
          requestId,
        );
      }
    },
  };
}

export function serveAsset(request, assets) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  const path = new URL(request.url).pathname;
  const asset = assets[path === "/" ? "/index.html" : path];
  if (!asset) return new Response("Not found", { status: 404 });
  const body =
    asset.encoding === "base64"
      ? Uint8Array.from(atob(asset.body), (ch) => ch.charCodeAt(0))
      : asset.body;
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": asset.type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}
