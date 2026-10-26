import {normalizeRows as normalizeCSV} from './csv.js';
export {parseCSV,detectMapping,parseNumber} from './csv.js';
export const normalizeRows=(parsed,mapping,name)=>normalizeCSV(parsed,mapping,name,products);
export const products = [
  { sku: 'NS-KM-001', name: 'Kemeja Senja', variant: 'Sage / M', category: 'Kemeja', price: 289000, stock: 18, minimum: 30, color: '#a8b59b', initials:'KS', sold:142 },
  { sku: 'NS-TS-002', name: 'Essential Tee', variant: 'Off-white / L', category: 'T-shirt', price: 149000, stock: 124, minimum: 40, color: '#ded9ca', initials:'ET', sold:206 },
  { sku: 'NS-CL-003', name: 'Celana Hari', variant: 'Sand / 30', category: 'Celana', price: 329000, stock: 67, minimum: 25, color: '#c8b18e', initials:'CH', sold:89 },
  { sku: 'NS-OT-004', name: 'Outer Rimba', variant: 'Forest / L', category: 'Outerwear', price: 459000, stock: 12, minimum: 20, color: '#667c68', initials:'OR', sold:58 },
  { sku: 'NS-KM-005', name: 'Kemeja Pagi', variant: 'Blue / S', category: 'Kemeja', price: 269000, stock: 86, minimum: 30, color: '#9caeba', initials:'KP', sold:112 },
  { sku: 'NS-TS-006', name: 'Everyday Longsleeve', variant: 'Terracotta / M', category: 'T-shirt', price: 189000, stock: 93, minimum: 30, color: '#b98a72', initials:'EL', sold:97 },
];

export const production = [
  { id:'PRD-024', name:'Essential Tee', variant:'Off-white · 3 ukuran', qty:240, stage:2, target:'2026-10-24', status:'Berjalan', supplier:'Atelier Bandung', completed:150 },
  { id:'PRD-023', name:'Kemeja Senja', variant:'Sage · 4 ukuran', qty:120, stage:1, target:'2026-10-20', status:'Terlambat', supplier:'Konveksi Cipta', completed:30 },
  { id:'PRD-022', name:'Celana Hari', variant:'Sand · 4 ukuran', qty:180, stage:3, target:'2026-10-23', status:'Quality check', supplier:'Atelier Bandung', completed:162 },
  { id:'PRD-021', name:'Outer Rimba', variant:'Forest · 3 ukuran', qty:90, stage:0, target:'2026-10-28', status:'Berjalan', supplier:'Konveksi Cipta', completed:0 },
];

export const initialFiles = [
  {id:'seed-sales',name:'penjualan_oktober_2026.csv',type:'CSV',domain:'Penjualan',rows:126,status:'Terhubung',date:'21 Okt, 09.42',size:'24 KB'},
  {id:'seed-stock',name:'stok_gudang_utama.xlsx',type:'XLSX',domain:'Persediaan',rows:6,status:'Terhubung',date:'21 Okt, 09.38',size:'18 KB'},
  {id:'seed-prod',name:'progres_produksi.xlsx',type:'XLSX',domain:'Produksi',rows:4,status:'Terhubung',date:'20 Okt, 16.15',size:'12 KB'},
  {id:'seed-pdf',name:'invoice_vendor_oktober.pdf',type:'PDF',domain:'Dokumen',rows:0,status:'Perlu review',date:'20 Okt, 15.04',size:'248 KB'},
];

export function seedOrders() {
  const rows=[];
  for(let day=1;day<=21;day++) {
    for(let n=0;n<6;n++) {
      const p=products[(day+n*3)%products.length];
      const qty=1+((day*3+n*2)%6);
      const subtotal=p.price*qty;
      const discount=(day+n)%7===0?Math.round(subtotal*0.1):0;
      rows.push({id:`ORD-${String(1000+day*6+n).padStart(4,'0')}`,date:`2026-10-${String(day).padStart(2,'0')}`,sku:p.sku,product:p.name,quantity:qty,unit_price:p.price,discount,total:subtotal-discount,status:(day+n)%13===0?'Diproses':'Selesai',channel:['Website','Shopee','Tokopedia'][(day+n)%3],source:'penjualan_oktober_2026.csv',row:rows.length+2,batch:'seed-sales'});
    }
  }
  return rows;
}

export function upsertOrders(current,incoming,batch) {
  const key=r=>`${r.id}\u0000${r.sku}`;
  const result=new Map(current.map(r=>[key(r),{...r}]));let added=0,updated=0,unchanged=0;
  const compare=r=>JSON.stringify([r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel]);
  for(const row of incoming){const k=key(row);const previous=result.get(k);if(previous&&compare(previous)===compare(row)){unchanged++;continue;}if(previous)updated++;else added++;const {errors,...record}=row;result.set(k,{...record,batch});}
  return {orders:[...result.values()],added,updated,unchanged};
}
export function metricSummary(rows) {
  return {revenue:rows.reduce((s,r)=>s+r.total,0),orders:new Set(rows.map(r=>r.id)).size,units:rows.reduce((s,r)=>s+r.quantity,0),discount:rows.reduce((s,r)=>s+r.discount,0)};
}
