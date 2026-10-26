# Backend contract

The primary distribution is now the personal Node.js loopback runtime in `local/`. It strips incoming identity headers and injects a stable local owner only for its own HttpOnly session cookie, with Host/Origin checks. ChatGPT OAuth is a separate provider connection; it does not replace database workspace ownership. The shared Worker-compatible core remains portable.


## Ownership and dependencies

One business deployment connects to one dedicated Supabase project. In a hosted adapter, the hosting platform must own authentication and site access; the API uses the trusted `oai-authenticated-user-id` as the record owner. Set `LARAS_OWNER_ID` to further restrict the API to a specific owner. For another deployment platform, provide a trusted authenticated reverse proxy that removes caller-supplied identity headers. This repository does not provide a public header-based login mechanism.

`server/app.js` owns routing and validation. `server/domain/` owns pure business rules. `server/services/` coordinates chat and project setup. `server/infrastructure/` owns network credentials and deadlines. The PostgreSQL RPC is the transaction boundary and independently scopes each operation by owner.

The `laras` schema has RLS enabled and no anonymous browser grants. Only `service_role` may execute the public `laras_rpc` and `laras_batch_rpc` functions; its fixed action dispatcher applies owner filters throughout. Supabase management mode calls that same function using safely encoded values, not client-generated SQL.

## HTTP

All business routes require identity. Mutations reject cross-site origins and accept JSON only. Success:

```json
{"data":{},"requestId":"..."}
```

Errors:

```json
{"error":{"code":"REVISION_CONFLICT","message":"Data telah berubah…"},"requestId":"..."}
```

Errors use 400 for malformed JSON, 401/403 for access, 404 for missing owner-scoped records, 409 for state conflicts, 413/415/422 for invalid input, 429 for limits, and 502/503/504 for dependency failures or timeouts. An unexpected exception returns a generic 500. Logs contain a request ID, path, and safe code; no keys or request bodies.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Runtime liveness only; no business or secret data |
| GET | `/api/status` | Configuration flags; does not assert upstream readiness |
| POST | `/api/setup` | Apply the bundled migration to the configured management project |
| GET | `/api/workspace?days=21` | Business snapshot, server analytics, findings, sources, history |
| GET | `/api/dashboard?days=21` | Authoritative metrics and chart series |
| GET | `/api/insights?days=21` | Current findings and review fingerprints |
| POST | `/api/insights/review` | `{fingerprint, reviewed: boolean}`; reject changed findings |
| PATCH | `/api/preferences` | `{name?, preferences?: {daily?, stock?, production?}}` |
| POST | `/api/imports/preview` | `{name, csv, mapping?}` plus `Idempotency-Key` |
| POST | `/api/imports/:id/commit` | `{approved: true}`; idempotent for the same committed batch |
| POST | `/api/imports/:id/rollback` | `{}`; cancel the latest data change, preserving prior sources |
| PUT | `/api/inventory` | `{revision, rows}`; update inventory by SKU |
| PUT | `/api/production` | `{revision, rows}`; update production by batch ID |
| POST | `/api/chat` | `{question, days?}` plus `Idempotency-Key` |
| GET | `/api/chat/history` | Latest 50 completed questions for the owner |

Read periods accept 1–366 days. Sales periods are anchored to the latest approved sales date; the exact range is returned in `period`. Production deadlines use the current date in `Asia/Jakarta`. All monetary values use IDR and SQL `numeric(18,2)`.

## Import lifecycle

1. Receive raw CSV and optional column mapping. Enforce 2 MB, 5,000 rows, 100 columns, valid dates, bounded values, and unique order ID/SKU pairs within the file.
2. Normalize and validate again on the server. Invalid rows reject the whole preview; they are never silently discarded.
3. Store a one-hour preview with a server revision and added/updated/unchanged counts. No sales records or source files change at this step.
4. Require explicit approval. Lock the workspace, reject stale revisions, create source metadata and changed rows, preserve before-images, increment the version, and write an audit event in one database transaction.
5. An identical retry of a completed commit returns the original result. An identical record under another file name does not create another business row or change its provenance.
6. Cancel only the latest committed change. Restore the previous records and their source references, remove newly added records and their now-unused source, and retain the import/audit history.

Idempotency keys bind to request content. Reusing a key with different content returns 409. Maximum active previews: 20 per owner. Expired previews cannot be committed. The current browser synchronization contract caps approved sales at 20,000 records. Future larger datasets need paginated transaction reads rather than silently truncated snapshots.

## Catalog payloads

Inventory rows:

```json
{"revision":0,"rows":[{"sku":"SKU-01","name":"Kemeja","variant":"M","stock":18,"minimum":30,"source":"stok.csv","source_row":2}]}
```

Production rows:

```json
{"revision":1,"rows":[{"id":"PRD-01","name":"Kemeja","qty":120,"completed":30,"stage":1,"target":"2026-10-24","supplier":"Konveksi Cipta","source":"produksi.csv"}]}
```

These operations upsert 1–500 rows atomically and require the last workspace revision. They do not infer inventory movements or delete omitted records. Source metadata is supplied by the authorized caller; these endpoints do not parse or verify a corresponding uploaded inventory/production file.

## Chat boundary

OpenRouter receives bounded evidence from the authenticated owner's approved snapshot: authoritative computed facts, a limited sample from the selected dataset, inventory facts, and ranked document excerpts. It does not receive API keys, original binary files, or unrelated server settings. The question and document contents are explicitly untrusted data. The model has no SQL or write tool. It returns a bounded JSON answer citing only evidence IDs supplied by the server; unknown IDs or invalid structure are rejected. Citation validation checks source identity, not semantic correctness. Deterministic facts remain separately available in AI answers.

The provider call has a 28-second timeout, bounded output, `data_collection: deny`, and a JSON-compatible model requirement. Provider, quota, or output errors fall back explicitly to deterministic rules. There are no automatic provider retries. Completed request keys are cached in PostgreSQL so acknowledged retries do not re-bill. The database enforces 20 chat starts per minute per owner; pending duplicates receive `CHAT_IN_PROGRESS`.

`GET/POST/DELETE /api/ai/connection` exposes connection flags, verifies and stores an owner-bound encrypted OpenRouter key, or deletes that owner's saved key. `POST` accepts `{key, model}` and verifies `/api/v1/key`; it does not bill for model inference. D1 metadata stores no plaintext key. Data-only requests never decrypt the AI key, so an invalid AI envelope does not interrupt database uploads. Deployment environment keys remain an optional operator-managed fallback.

## Operational setup

Bring an existing project with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, or use management credentials with a unique project reference/name. Prefer direct PostgREST mode once a project is provisioned; management mode is useful for automated initial setup and has separate Management API quotas.

Both in-app provisioning and the provisioning CLI verify the organization's actual billing plan before creating a project: the deprecated create-project `plan` parameter does not control billing. They request the smallest instance, never upgrade a plan, and stop on quota errors. A local lock and non-secret creation journal prevent duplicate creation from retries in one operator environment. It does not provide distributed provisioning coordination; do not run parallel provisioning operators for the same business.

Migrations `001_laras.sql` and `002_multi_documents.sql` are additive and repeatable. They create only the `laras` schema and the `public.laras_rpc` / `public.laras_batch_rpc` dispatchers; it does not change unrelated tables. The browser never receives a service key or management token.

Runtime variable changes require a redeployment. Use `/api/health` for runtime liveness, `/api/status` for flags, and an authenticated `/api/workspace` read to verify database connectivity. A healthy Worker or configured key alone is not proof that Supabase or OpenRouter has been exercised.

## Verification and limits

Local tests run actual PostgreSQL SQL through PGlite, not a mock persistence implementation. HTTP adapters and OpenRouter responses are intercepted in selected tests to exercise transport failures and verify the model receives only selected business evidence and no credentials. Browser workflow tests use jsdom and call the real API/database implementation.

PGlite serializes its connection; these tests do not establish concurrency performance across multiple real Supabase connections. The database transaction and row-lock design handles that boundary, but real service integration, load testing, and interactive browser layout checks require the corresponding environments. No real cloud project or live model call is claimed without the account's configured credentials.

Official references: [Supabase create-project API](https://supabase.com/docs/reference/api/v1-create-a-project), [organization billing metadata](https://supabase.com/docs/reference/api/v1-get-an-organization), [database query API](https://supabase.com/docs/reference/api/v1-run-a-query), and [OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request).


## Multi-document uploads and automatic cloud setup

D1 is the control store only: `cloud_connections` holds the owner-bound AES-GCM token envelope and non-secret project metadata; `provisioning_jobs` holds the durable create marker, project reference, phase, and 120-second fenced lease. Never rotate `LARAS_ENCRYPTION_KEY` casually: saved connections require the same key. Local development applies the generated Drizzle migrations at process startup to `.laras/control.sqlite`; local runtime migrations are applied before serving requests; a hosted adapter must apply its migrations through its deployment tooling. Request handlers do not create control tables.

`POST /api/cloud/organizations` accepts `{token}` and returns only accessible organization names and canonical slugs from the Supabase Management API, without storing the token or changing the cloud account. Identity and same-origin checks still apply. Changing the token invalidates the UI selection and stale lookup results are ignored.

`POST /api/cloud/connection` accepts `{token, organization, projectName}` over the authenticated same-origin API. It verifies organization access and the Free plan before saving encrypted credentials. Project names accept ordinary text up to 80 characters without a required prefix; control characters are rejected. Status responses expose flags and project identifiers only. Changing the destination while its job holds a lease or has an uncertain create attempt is rejected; token rotation for the same destination preserves the remembered reference.

`POST /api/cloud/provision` advances one bounded step. The phases are `pending`, `creating`, `starting`, `migrating`, `ready`, `uncertain`, and `failed`. The browser resumes this endpoint every five seconds while processing selected files. Successful project creation is recorded before waiting for database readiness. After a timeout or uncertain result, a later request searches for the same organization/name; it never blindly posts a second creation. Explicit provider rejections may be retried after correcting configuration or quota. Separate operator CLI processes do not share this lease.

Additional endpoints:

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/api/documents/extract` | `{name, base64}` plus Idempotency-Key; parse and stage one document in Supabase |
| GET | `/api/documents/:id` | Owner-scoped metadata, table previews, or document text with page, slide, or section references |
| GET | `/api/documents/:id/download` | Download the unchanged original as an attachment |
| DELETE | `/api/documents/:id` | Discard a staged file only; committed documents are protected |
| POST | `/api/uploads/preview` | `{documents: [{id, tables: [{id, domain, mapping, include}]}]}` plus Idempotency-Key |
| POST | `/api/uploads/:id/commit` | `{approved:true}`; one atomic, retry-safe group commit |

Upload stages expire after 24 hours. Re-uploading identical content reuses the owner's existing valid stage or committed document, including after a browser reload. The UI can exclude or remove failed files. A committed document is never deleted by removing an upload-queue item.

CSV and XLSX normalization runs on the server. An XLSX can contain up to ten worksheets with per-sheet domain selection and column mapping. Supported domains are sales, inventory, and production. Dates, required columns, quantities, identifiers, and conflicting cross-file keys are validated before preview. Identical cross-file rows are deduplicated visibly. A group permits at most 20 documents, 2 MB each, 10 MB combined, and 10,000 structured rows; the existing 20,000 sales-row workspace limit still applies.

PDFs are parsed sequentially with evaluation disabled. Up to 20 pages / 100,000 text characters are accepted. PDF originals and page text are archived with a review status; they never silently become sales metrics. OCR for scanned pages is unavailable. Workbook XML rejects DTD/entity declarations and external worksheet references, and decompression is bounded. Formula caches can be read; spreadsheet formulas are never executed.

The batch RPC stores staged originals and table/page structure, then saves a revision-bound preview. On approval it commits source metadata, sales, inventory, production, before-images, and an audit event in the same PostgreSQL transaction. It rejects expired/missing documents or stale revisions before writing. Rollback restores all affected domains and source references and works across the original single-file and grouped histories. Full document reads use the owner-scoped document endpoints; workspace synchronization includes only bounded PDF snippets.

Verification includes real parser fixtures, grouped SQL failure injection, mixed-domain rollback, ciphertext/owner binding, simultaneous provisioning requests, restart recovery, and the full connection-form → simulated Management API → database-ready → document staging → approval journey. A simulated API proves integration behavior; an actual Supabase project cannot be created until a real token and Free organization are connected in the app.


## Business-neutral analytical datasets

Migration 002 also registers each approved table in `laras.datasets` with owner, original document/worksheet reference, inferred columns, domain, and row count. It points to the immutable parsed original instead of duplicating full row payloads. Dataset registration, specialized domain writes when applicable, and the source metadata commit atomically; rollback restores all of them.

Generic business tables use the `dataset` domain by default when their structure is not a confident match for a specialized domain. They have no mandatory sales/order/SKU fields. An owner-scoped `dataset_get` action retrieves one approved table for bounded in-server analytics. Workspace responses include dataset metadata and an adaptive dashboard model, with legacy normalized sales available as a compatibility source.

`GET /api/adaptive-dashboard?datasetId=...&adaptiveDays=all&metricKey=c3&dateKey=c0&groupKey=c2` returns KPIs, date series, category breakdowns, source rows, column options, and data-quality findings. `metricKey=count`, `dateKey=none`, and `groupKey=none` disable or change the corresponding analysis. Offsets paginate source rows in groups of 50. Analytical selections are validated against the owner's actual columns. The API does not accept SQL, arbitrary expressions, or unapproved table names.

Defaults derive from column types and name hints; the selected source and calculation remain explicit. Dates and sums never imply an online shop if the source describes projects, clients, appointments, staff, or another operation. Only verified specialized datasets expose their corresponding sales/inventory/production tabs. Demo examples include service projects, staff operations, and reservations, with metrics computed from those sample rows.

Generic chat uses the same dataset model for totals, averages, minima/maxima, entity counts, and supported findings. Its idempotency hash includes the selected source and period. OpenRouter can receive bounded text excerpts and selected table samples, while original binaries remain in Supabase. Automatic classification is a starting point: ambiguous semantics can be corrected through source/measure/date/group selectors. Cross-dataset joins, arbitrary calculations, and PDF-to-financial-ledger extraction are not inferred.

Inventory reorder thresholds are optional in CSV/Excel and the catalog API. An unmapped or empty threshold is stored as zero, leaving `stock < minimum` alerts inactive; an explicitly supplied invalid value is rejected. The review selector displays this default as “Tidak diatur (0)”. Replacing an existing product without a threshold also uses zero. Original document columns remain available in the adaptive dataset. Catalog validation reports the affected numeric field and document/worksheet/source row instead of an analysis-period error.

DOCX/PPTX/TXT/MD are supported as reviewable text documents. Office XML namespaces are normalized for element lookup while relationship IDs are preserved. Decompression and text lengths are bounded, external slide references and DTD declarations are rejected, and the original bytes remain available for download. Migration 003 expands document formats and includes these texts in source snapshots. Schema hashes on provisioning jobs cause existing managed projects to migrate on their next upload, without recreating their database.
