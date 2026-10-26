import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { getDocumentProxy } from "unpdf";
import { parseCSV, detectMapping } from "../../web/csv.js";
import { prepareImport } from "./imports.js";
import { inferColumns } from "../../web/adaptive.js";
import { validateCatalog } from "./catalog.js";
import {
  catalogMapping,
  tableDomain,
  domains,
} from "../../web/document-fields.js";
import { parseNumber } from "../../web/csv.js";
import { AppError, text, sha256, uuid } from "../http.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  processEntities: true,
  transformTagName: (name) => name.split(":").at(-1),
});
const orderedParser = new XMLParser({
  ignoreAttributes: true,
  preserveOrder: true,
  parseTagValue: false,
  transformTagName: (name) => name.split(":").at(-1),
});
function officeText(bytes) {
  const value = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(value))
    throw new AppError(
      422,
      "XML_UNSUPPORTED",
      "XML dengan entitas eksternal tidak didukung.",
    );
  let output = "";
  function walk(nodes, depth = 0) {
    if (depth > 100)
      throw new AppError(
        422,
        "XML_TOO_DEEP",
        "Struktur dokumen terlalu dalam.",
      );
    for (const node of list(nodes))
      for (const [key, children] of Object.entries(node)) {
        if (key === "#text") output += String(children);
        else if (key === "tab") output += "\t";
        else if (key === "br") output += "\n";
        else if (Array.isArray(children)) {
          walk(children, depth + 1);
          if (key === "p") output += "\n";
        }
        if (output.length > 100000)
          throw new AppError(
            422,
            "TEXT_LIMIT",
            "Teks dokumen maksimal 100.000 karakter.",
          );
      }
  }
  walk(orderedParser.parse(value));
  return output.trim();
}
function officePages(bytes, extension) {
  let inflated = 0;
  const zip = unzipSync(bytes, {
    filter(file) {
      if (
        !(
          extension === "docx"
            ? /^word\/document\.xml$/
            : /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)$/
        ).test(file.name)
      )
        return false;
      inflated += file.originalSize;
      if (file.originalSize > 5_000_000 || inflated > 20_000_000)
        throw new AppError(
          422,
          "OFFICE_TOO_LARGE",
          "Isi dokumen melebihi batas pemrosesan.",
        );
      return true;
    },
  });
  if (extension === "docx") {
    if (!zip["word/document.xml"])
      throw new AppError(
        422,
        "OFFICE_INVALID",
        "Struktur dokumen Word tidak valid.",
      );
    return [
      { page: 1, label: "Dokumen", text: officeText(zip["word/document.xml"]) },
    ];
  }
  if (!zip["ppt/presentation.xml"] || !zip["ppt/_rels/presentation.xml.rels"])
    throw new AppError(
      422,
      "OFFICE_INVALID",
      "Struktur presentasi tidak valid.",
    );
  const slides = list(
    xml(zip["ppt/presentation.xml"]).presentation?.sldIdLst?.sldId,
  );
  const rels = list(
    xml(zip["ppt/_rels/presentation.xml.rels"]).Relationships?.Relationship,
  );
  if (!slides.length || slides.length > 50)
    throw new AppError(
      422,
      "SLIDE_LIMIT",
      "Presentasi harus memuat 1–50 slide.",
    );
  let length = 0;
  return slides.map((slide, i) => {
    const rel = rels.find((r) => r["@Id"] === slide["@r:id"]);
    const target = String(rel?.["@Target"] || "").replace(/^\/?ppt\//, "");
    if (
      rel?.["@TargetMode"] === "External" ||
      !/^slides\/slide\d+\.xml$/.test(target) ||
      !zip["ppt/" + target]
    )
      throw new AppError(422, "OFFICE_INVALID", "Relasi slide tidak valid.");
    const text = officeText(zip["ppt/" + target]);
    length += text.length;
    if (length > 100000)
      throw new AppError(
        422,
        "TEXT_LIMIT",
        "Teks presentasi maksimal 100.000 karakter.",
      );
    return { page: i + 1, label: `Slide ${i + 1}`, text };
  });
}
const list = (value) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const xml = (bytes) => {
  const content = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(content))
    throw new AppError(
      422,
      "XML_UNSUPPORTED",
      "XML dengan entitas eksternal tidak didukung.",
    );
  return parser.parse(content);
};
const plain = (value) =>
  typeof value === "object"
    ? String(value?.["#text"] ?? "")
    : String(value ?? "");
const rich = (value) =>
  value?.t !== undefined
    ? plain(value.t)
    : list(value?.r)
        .map((r) => plain(r.t))
        .join("");
function tableResult(id, sheet, parsed) {
  if (!parsed.rows.length)
    throw new AppError(422, "EMPTY_TABLE", "Tabel tidak memuat baris data.");
  if (parsed.headers.length > 100 || parsed.rows.length > 5000)
    throw new AppError(
      422,
      "TABLE_LIMIT",
      "Batas tabel: 100 kolom dan 5.000 baris.",
    );
  if (
    parsed.headers.some((h) => !h) ||
    new Set(parsed.headers.map((h) => h.toLowerCase())).size !==
      parsed.headers.length
  )
    throw new AppError(
      422,
      "HEADERS_INVALID",
      "Nama kolom harus terisi dan unik.",
    );
  const domain = tableDomain(parsed.headers);
  return {
    id,
    sheet,
    domain,
    headers: parsed.headers,
    rows: parsed.rows,
    mapping:
      domain === "sales"
        ? detectMapping(parsed.headers)
        : catalogMapping(parsed.headers, domain),
  };
}
function excelDate(value, date1904) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const date = new Date(
    Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) +
      Math.round(number * 86400000),
  );
  return Number.isFinite(+date) ? date.toISOString().slice(0, 10) : value;
}
export function workbookTables(bytes) {
  let inflated = 0;
  const zip = unzipSync(bytes, {
    filter: (file) => {
      if (
        !/^(xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml))$/.test(
          file.name,
        )
      )
        return false;
      inflated += file.originalSize;
      if (file.originalSize > 5_000_000 || inflated > 20_000_000)
        throw new AppError(
          422,
          "WORKBOOK_TOO_LARGE",
          "Isi Excel melebihi batas pemrosesan.",
        );
      return true;
    },
  });
  if (!zip["xl/workbook.xml"] || !zip["xl/_rels/workbook.xml.rels"])
    throw new AppError(
      422,
      "XLSX_INVALID",
      "Struktur berkas XLSX tidak valid.",
    );
  const workbook = xml(zip["xl/workbook.xml"]).workbook;
  const relationships = list(
    xml(zip["xl/_rels/workbook.xml.rels"]).Relationships?.Relationship,
  );
  const strings = zip["xl/sharedStrings.xml"]
    ? list(xml(zip["xl/sharedStrings.xml"]).sst?.si).map(rich)
    : [];
  const style = zip["xl/styles.xml"]
    ? xml(zip["xl/styles.xml"]).styleSheet
    : {};
  const custom = new Map(
    list(style.numFmts?.numFmt).map((f) => [
      String(f["@numFmtId"]),
      String(f["@formatCode"]),
    ]),
  );
  const dates = list(style.cellXfs?.xf).map((f) => {
    const id = Number(f["@numFmtId"]);
    const format = custom.get(String(id)) || "";
    return (
      (id >= 14 && id <= 22) ||
      (id >= 45 && id <= 47) ||
      (/[yd]/i.test(format.replace(/"[^"]*"/g, "")) && !/\[h\]/i.test(format))
    );
  });
  const sheets = list(workbook?.sheets?.sheet);
  if (sheets.length > 10)
    throw new AppError(
      422,
      "SHEET_LIMIT",
      "Maksimal 10 lembar kerja per berkas.",
    );
  const date1904 = ["1", "true"].includes(
    String(workbook?.workbookPr?.["@date1904"]),
  );
  let total = 0;
  const tables = [];
  for (const [index, sheet] of sheets.entries()) {
    const rel = relationships.find((r) => r["@Id"] === sheet["@r:id"]);
    if (!rel || rel["@TargetMode"] === "External")
      throw new AppError(
        422,
        "XLSX_INVALID",
        "Relasi lembar kerja tidak valid.",
      );
    const target = String(rel["@Target"]).replace(/^\/?xl\//, "");
    if (target.includes("..") || !/^worksheets\/[^/]+\.xml$/.test(target))
      throw new AppError(
        422,
        "XLSX_INVALID",
        "Lokasi lembar kerja tidak valid.",
      );
    const data = zip["xl/" + target];
    if (!data)
      throw new AppError(422, "XLSX_INVALID", "Lembar kerja tidak ditemukan.");
    const rows = [];
    for (const [rowIndex, row] of list(
      xml(data).worksheet?.sheetData?.row,
    ).entries()) {
      const values = [];
      for (const [cellIndex, cell] of list(row.c).entries()) {
        const letters = String(cell["@r"] || "").match(/^[A-Z]+/)?.[0];
        let column = cellIndex;
        if (letters) {
          column = 0;
          for (const ch of letters)
            column = column * 26 + ch.charCodeAt(0) - 64;
          column--;
        }
        if (column >= 100)
          throw new AppError(
            422,
            "COLUMN_LIMIT",
            "Maksimal 100 kolom per lembar kerja.",
          );
        let value =
          cell["@t"] === "s"
            ? strings[Number(cell.v)]
            : cell["@t"] === "inlineStr"
              ? rich(cell.is)
              : plain(cell.v);
        if (cell["@t"] === "d") value = value.slice(0, 10);
        else if (dates[Number(cell["@s"])] && /^\d+(\.\d+)?$/.test(value))
          value = excelDate(value, date1904);
        values[column] = String(value ?? "");
      }
      if (values.some((v) => v?.trim()))
        rows.push({
          values: Array.from(
            { length: values.length },
            (_, i) => values[i] || "",
          ),
          line: Number(row["@r"]) || rowIndex + 1,
        });
    }
    if (rows.length < 2) continue;
    const headers = rows.shift().values.map((v) => v.trim());
    total += rows.length;
    if (total > 5000)
      throw new AppError(
        422,
        "ROW_LIMIT",
        "Maksimal 5.000 baris data per berkas Excel.",
      );
    tables.push(
      tableResult(
        "sheet-" + index,
        String(sheet["@name"] || "Lembar " + (index + 1)),
        { headers, rows },
      ),
    );
  }
  if (!tables.length)
    throw new AppError(
      422,
      "EMPTY_WORKBOOK",
      "Tidak ada tabel data dalam berkas Excel.",
    );
  return tables;
}
async function pdfPages(bytes) {
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes, {
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      disableAutoFetch: true,
      maxImageSize: 1000000,
      verbosity: 0,
    });
    if (pdf.numPages > 20)
      throw new AppError(422, "PAGE_LIMIT", "Maksimal 20 halaman per PDF.");
    const pages = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent({
        disableNormalization: false,
      });
      const value = content.items
        .map((item) => (item.str ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
        .trim();
      length += value.length;
      if (length > 100000)
        throw new AppError(
          422,
          "TEXT_LIMIT",
          "Teks PDF melebihi batas pemrosesan.",
        );
      pages.push({ page: number, text: value });
      page.cleanup();
    }
    return pages;
  } finally {
    await pdf?.loadingTask?.destroy();
  }
}
export async function extractDocument(body) {
  const name = text(body.name, "Nama berkas", 160);
  if (/[\/\\]/.test(name))
    throw new AppError(422, "INVALID_FILENAME", "Nama berkas tidak valid.");
  const extension = name.split(".").at(-1).toLowerCase();
  if (!["csv", "xlsx", "pdf", "docx", "pptx", "txt", "md"].includes(extension))
    throw new AppError(
      422,
      "FORMAT_UNSUPPORTED",
      "Format yang didukung: CSV, XLSX, PDF, DOCX, PPTX, TXT, dan Markdown.",
    );
  if (
    typeof body.base64 !== "string" ||
    body.base64.length > 2_670_000 ||
    body.base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)
  )
    throw new AppError(
      413,
      "FILE_TOO_LARGE",
      "Berkas tidak valid atau melebihi 2 MB.",
    );
  let bytes;
  try {
    bytes = Uint8Array.from(atob(body.base64), (c) => c.charCodeAt(0));
  } catch {
    throw new AppError(422, "FILE_INVALID", "Berkas tidak valid.");
  }
  if (!bytes.length || bytes.length > 2_000_000)
    throw new AppError(413, "FILE_TOO_LARGE", "Ukuran berkas maksimal 2 MB.");
  let tables = [],
    pages = [];
  try {
    if (extension === "csv") {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      tables = [tableResult("csv", "", parseCSV(value))];
    }
    if (extension === "xlsx") tables = workbookTables(bytes);
    if (["docx", "pptx"].includes(extension))
      pages = officePages(bytes, extension);
    if (["txt", "md"].includes(extension)) {
      const value = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/^\uFEFF/, "");
      if (
        value.length > 100000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
      )
        throw new AppError(
          422,
          "TEXT_INVALID",
          "Gunakan teks UTF-8, maksimal 100.000 karakter.",
        );
      pages = [
        {
          page: 1,
          label: extension === "md" ? "Markdown" : "Teks",
          text: value,
        },
      ];
    }
    if (extension === "pdf") {
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
        throw new Error();
      pages = await pdfPages(bytes.slice());
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      "EXTRACTION_FAILED",
      "Berkas tidak dapat dibaca. Pastikan berkas tidak rusak atau terkunci.",
    );
  }
  return {
    name,
    type: extension.toUpperCase(),
    size: bytes.length,
    hash: await sha256(body.base64),
    original: body.base64,
    content: { tables, pages },
    rowCount: tables.reduce((n, t) => n + t.rows.length, 0),
  };
}
export function documentSummary(document) {
  return {
    id: document.id,
    name: document.name,
    type: document.type,
    size: document.size,
    hash: document.hash,
    tables: (document.content.tables || []).map((t) => ({
      id: t.id,
      sheet: t.sheet,
      domain: t.domain || "sales",
      headers: t.headers,
      mapping:
        (t.domain || "sales") === "sales"
          ? detectMapping(t.headers)
          : catalogMapping(t.headers, t.domain),
      rowCount: t.rows.length,
      sample: t.rows.slice(0, 5),
    })),
    pages: document.content.pages || [],
    review: !["CSV", "XLSX"].includes(document.type),
    duplicate: document.status === "committed",
  };
}
const csvCell = (value) =>
  '"' + String(value ?? "").replaceAll('"', '""') + '"';
export async function prepareDocumentBatch(selection, documents) {
  if (
    !Array.isArray(selection) ||
    selection.length < 1 ||
    selection.length > 20
  )
    throw new AppError(422, "FILE_LIMIT", "Pilih 1–20 dokumen.");
  const ids = new Map();
  const rows = [];
  const datasets = [];
  const catalog = { inventory: [], production: [] };
  const records = [];
  const keys = new Map();
  let size = 0,
    duplicates = 0;
  for (const item of selection) {
    uuid(item.id);
    const document = documents.find((d) => d.id === item.id);
    if (!document)
      throw new AppError(404, "DOCUMENT_NOT_FOUND", "Dokumen tidak ditemukan.");
    if (ids.has(item.id)) {
      if (ids.get(item.id) !== JSON.stringify(item.tables || []))
        throw new AppError(
          422,
          "DOCUMENT_SELECTION_CONFLICT",
          "Berkas yang sama memiliki pemetaan berbeda. Pilih satu berkas.",
        );
      duplicates += (document.content.tables || [])
        .filter(
          (t) => item.tables?.find((x) => x.id === t.id)?.include !== false,
        )
        .reduce((n, t) => n + t.rows.length, 0);
      continue;
    }
    ids.set(item.id, JSON.stringify(item.tables || []));
    if (
      document.status === "staged" &&
      new Date(document.expires_at) < new Date()
    )
      throw new AppError(
        409,
        "DOCUMENT_EXPIRED",
        "Dokumen kedaluwarsa. Unggah kembali.",
      );
    size += document.size;
    if (size > 10_000_000)
      throw new AppError(
        413,
        "BATCH_TOO_LARGE",
        "Total berkas maksimal 10 MB.",
      );
    let count = 0;
    const kinds = new Set();
    for (const table of document.content.tables || []) {
      const chosen = item.tables?.find((t) => t.id === table.id);
      if (chosen?.include === false) continue;
      const domain = chosen?.domain || table.domain || "sales";
      if (!domains[domain])
        throw new AppError(422, "INVALID_DOMAIN", "Jenis data tidak valid.");
      kinds.add(domains[domain].label);
      datasets.push({
        documentId: document.id,
        partId: table.id,
        part: table.sheet,
        domain,
        columns: inferColumns(table.headers, table.rows),
        rowCount: table.rows.length,
      });
      if (domain === "dataset") {
        count += table.rows.length;
        continue;
      }
      if (domain !== "sales") {
        const mapping =
          chosen?.mapping || catalogMapping(table.headers, domain);
        if (
          !mapping ||
          Object.entries(mapping).some(
            ([key, value]) =>
              !Object.hasOwn(domains[domain].fields, key) ||
              (value !== "" &&
                (!/^\d+$/.test(String(value)) ||
                  Number(value) >= table.headers.length)),
          )
        )
          throw new AppError(
            422,
            "MAPPING_INVALID",
            "Pemetaan kolom tidak valid.",
          );
        for (const line of table.rows) {
          const get = (key) =>
            mapping[key] !== "" && mapping[key] !== undefined
              ? (line.values[Number(mapping[key])] ?? "")
              : "";
          let data;
          if (domain === "inventory")
            data = {
              sku: get("sku"),
              name: get("name") || get("sku"),
              variant: get("variant"),
              stock: parseNumber(get("stock")),
              // No supplied threshold means low-stock alerts remain inactive (stock < 0).
              minimum:
                get("minimum").trim() === "" ? 0 : parseNumber(get("minimum")),
              source: document.name,
              source_row: line.line,
            };
          else {
            let target = get("target");
            if (/^\d{2}[/-]\d{2}[/-]\d{4}$/.test(target)) {
              const [d, m, y] = target.split(/[/-]/);
              target = `${y}-${m}-${d}`;
            }
            const stages = {
              persiapan: 0,
              jahit: 1,
              penjahitan: 1,
              finishing: 2,
              penyelesaian: 2,
              "quality check": 3,
              qc: 3,
              "pemeriksaan mutu": 3,
            };
            const rawStage = get("stage").toLowerCase();
            const stage = Object.hasOwn(stages, rawStage)
              ? stages[rawStage]
              : rawStage === ""
                ? 0
                : parseNumber(rawStage);
            data = {
              id: get("id"),
              name: get("name"),
              variant: get("variant"),
              qty: parseNumber(get("qty")),
              completed:
                get("completed") === "" ? 0 : parseNumber(get("completed")),
              stage,
              target,
              supplier: get("supplier"),
              source: document.name,
            };
          }
          let validated;
          try {
            validated = validateCatalog({ revision: 0, rows: [data] }, domain)
              .rows[0];
          } catch (error) {
            throw new AppError(
              422,
              "VALIDATION_FAILED",
              `${document.name} · ${table.sheet || "Data"} · baris ${line.line}: ${error.message}`,
              {
                documentId: document.id,
                tableId: table.id,
                row: line.line,
                ...(error.details || {}),
              },
            );
          }
          count++;
          const key = domain + ":" + (validated.sku || validated.id);
          const business = JSON.stringify(
            Object.fromEntries(
              Object.entries(validated).filter(
                ([k]) => !["source", "source_row"].includes(k),
              ),
            ),
          );
          if (keys.has(key)) {
            if (keys.get(key) !== business)
              throw new AppError(
                422,
                "CROSS_FILE_CONFLICT",
                `Data ${validated.sku || validated.id} berbeda antar dokumen.`,
              );
            duplicates++;
            continue;
          }
          keys.set(key, business);
          catalog[domain].push({
            ...validated,
            source_row: line.line,
            part: table.sheet,
            documentId: document.id,
          });
        }
        continue;
      }
      const csv = [table.headers, ...table.rows.map((r) => r.values)]
        .map((values) => values.map(csvCell).join(","))
        .join("\n");
      const prepared = await prepareImport({
        name: "data.csv",
        csv,
        mapping: chosen?.mapping || detectMapping(table.headers),
      });
      if (prepared.errors.length)
        throw new AppError(
          422,
          "VALIDATION_FAILED",
          `Periksa kolom pada ${document.name}${table.sheet ? " · " + table.sheet : ""}.`,
          {
            documentId: document.id,
            tableId: table.id,
            errors: prepared.errors.slice(0, 10),
          },
        );
      for (const [index, row] of prepared.rows.entries()) {
        count++;
        const business = JSON.stringify([
          row.date,
          row.product,
          row.quantity,
          row.unit_price,
          row.discount,
          row.total,
          row.status,
          row.channel,
        ]);
        const key = "sales:" + row.id + "\0" + row.sku;
        if (keys.has(key)) {
          duplicates++;
          if (keys.get(key) !== business)
            throw new AppError(
              422,
              "CROSS_FILE_CONFLICT",
              `ID ${row.id} dan SKU ${row.sku} memiliki nilai berbeda antar dokumen.`,
            );
          continue;
        }
        keys.set(key, business);
        const { errors, ...normalized } = row;
        rows.push({
          ...normalized,
          source: document.name,
          documentId: document.id,
          part: table.sheet,
          row: table.rows[index].line,
        });
      }
    }
    if (
      ["CSV", "XLSX"].includes(document.type) &&
      !count &&
      !document.content.tables?.some(
        (t) => item.tables?.find((x) => x.id === t.id)?.include !== false,
      )
    )
      throw new AppError(
        422,
        "TABLE_REQUIRED",
        "Pilih minimal satu lembar kerja untuk " + document.name + ".",
      );
    records.push({
      id: document.id,
      name: document.name,
      type: document.type,
      hash: document.hash,
      size: document.size,
      rows: count,
      domain: !["CSV", "XLSX"].includes(document.type)
        ? "Dokumen"
        : kinds.size === 1
          ? [...kinds][0]
          : "Campuran",
    });
  }
  if (
    rows.length +
      catalog.inventory.length +
      catalog.production.length +
      datasets
        .filter((d) => d.domain === "dataset")
        .reduce((n, d) => n + d.rowCount, 0) >
    10000
  )
    throw new AppError(
      422,
      "BATCH_ROW_LIMIT",
      "Maksimal 10.000 baris per kelompok impor.",
    );
  return { rows, catalog, datasets, documents: records, duplicates };
}
