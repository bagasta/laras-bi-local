import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCSV,detectMapping,normalizeRows,upsertOrders,seedOrders,metricSummary,parseNumber} from '../web/data.js';

test('CSV reads BOM, semicolon separators, escaped quotes, and multiline fields',()=>{
 const p=parseCSV('\uFEFFid;produk;jumlah\r\n1;"Kemeja, ""Senja""";2');
 assert.deepEqual(p.headers,['id','produk','jumlah']);
 assert.equal(p.rows[0].values[1],'Kemeja, "Senja"');
 const multi=parseCSV('id,product\n1,"baris satu\nbaris dua"');
 assert.equal(multi.rows[0].values[1],'baris satu\nbaris dua');
});

test('malformed CSV is rejected',()=>{
 assert.throws(()=>parseCSV('id,total\n1,"200'),/kutip/);
 assert.throws(()=>parseCSV('id,id\n1,2'),/tidak boleh sama/);
 assert.throws(()=>parseCSV('id,total'),/minimal/);
});

test('Indonesian and standard numeric formats normalize consistently',()=>{
 assert.equal(parseNumber('Rp 1.234.500'),1234500);
 assert.equal(parseNumber('1.234,50'),1234.5);
 assert.equal(parseNumber('1,234.50'),1234.5);
 assert.equal(parseNumber('1234.5'),1234.5);
 assert.ok(Number.isNaN(parseNumber('')));
});

test('mapping computes total and rejects invalid calendar dates',()=>{
 const p=parseCSV('id_pesanan,tanggal,kode_barang,jumlah,harga,diskon\nA1,21/10/2026,SKU-1,2,100000,10000\nA2,31/02/2026,SKU-1,1,100000,0');
 const rows=normalizeRows(p,detectMapping(p.headers),'sales.csv');
 assert.equal(rows[0].date,'2026-10-21');
 assert.equal(rows[0].total,190000);
 assert.deepEqual(rows[0].errors,[]);
 assert.ok(rows[1].errors.includes('Tanggal tidak valid'));
});

test('business keys prevent duplicates across filenames and update existing rows',()=>{
 const before=seedOrders();const row={...before[0],source:'different-name.csv',errors:[]};
 const same=upsertOrders(before,[row],'batch-1');
 assert.equal(same.orders.length,before.length);assert.equal(same.unchanged,1);
 const changed=upsertOrders(before,[{...row,total:row.total+1000},{...row,id:'NEW-1'}],'batch-2');
 assert.equal(changed.added,1);assert.equal(changed.updated,1);
 assert.equal(changed.orders.length,before.length+1);
 assert.equal(changed.orders.find(r=>r.id===row.id&&r.sku===row.sku).batch,'batch-2');
 assert.equal(before[0].total,row.total);
});

test('revenue and unique-order metrics use transaction grain',()=>{
 const result=metricSummary([{id:'A',quantity:2,total:100,discount:10},{id:'A',quantity:3,total:200,discount:0}]);
 assert.deepEqual(result,{revenue:300,orders:1,units:5,discount:10});
});
