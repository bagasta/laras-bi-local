export const projectCSV =
  "tanggal,proyek,klien,nilai_kontrak,jam_kerja,status,tenggat\n2026-10-26,Desain layanan,Klien A,200000,4,Berjalan,2026-11-02";

export function textFile(name, text) {
  const bytes = new TextEncoder().encode(text);
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer };
}

export function dropFiles(w, files) {
  const zone = w.document.querySelector("#multi-dropzone");
  const event = new w.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  zone.dispatchEvent(event);
}
