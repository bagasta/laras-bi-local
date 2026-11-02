export {parseCSV,detectMapping,parseNumber} from './csv.js';
export function metricSummary(rows) {
  return {revenue:rows.reduce((s,r)=>s+r.total,0),orders:new Set(rows.map(r=>r.id)).size,units:rows.reduce((s,r)=>s+r.quantity,0),discount:rows.reduce((s,r)=>s+r.discount,0)};
}
