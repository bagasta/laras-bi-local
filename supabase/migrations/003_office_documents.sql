begin;
alter table laras.documents drop constraint if exists documents_type_check;
alter table laras.documents add constraint documents_type_check check(type in ('CSV','XLSX','PDF','DOCX','PPTX','TXT','MD'));

create or replace function laras.snapshot_v2(p_owner text,p_days integer)
returns jsonb language sql stable set search_path=pg_catalog,laras as $$
 select laras.snapshot(p_owner,p_days)||jsonb_build_object(
 'datasets',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name',s.name,'label',s.name||case when d.part_name<>'' then ' · '||d.part_name else '' end,'part_name',d.part_name,'domain',d.domain,'row_count',d.row_count,'columns',d.columns,'document_id',d.document_id,'source_id',d.source_id) order by d.created_at desc,d.id) from laras.datasets d join laras.sources s on s.id=d.source_id and s.owner_id=d.owner_id where d.owner_id=p_owner),'[]'::jsonb),
 'files',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'type',s.file_type,'domain',s.domain,'rows',s.rows_count,'status',s.status,'date',s.created_at,'size',s.size_bytes,'documentId',s.document_id,'pages',(select coalesce(jsonb_array_length(f.content->'pages'),0) from laras.documents f where f.id=s.document_id and f.owner_id=s.owner_id)) order by s.created_at) from laras.sources s where s.owner_id=p_owner),'[]'::jsonb),
 'history',coalesce((select jsonb_agg(h order by h->>'date',h->>'id') from(
  select jsonb_build_object('id',i.id,'name',i.name,'date',i.committed_at,'added',i.added,'updated',i.updated,'unchanged',i.unchanged,'rolledBack',i.status='rolled_back','revision',i.committed_revision,'kind','legacy') h from laras.imports i where i.owner_id=p_owner and i.status in('committed','rolled_back')
  union all select jsonb_build_object('id',b.id,'name',jsonb_array_length(b.documents)||' dokumen','date',b.committed_at,'added',b.added,'updated',b.updated,'unchanged',b.unchanged,'rolledBack',b.status='rolled_back','revision',b.committed_revision,'kind','batch') from laras.upload_batches b where b.owner_id=p_owner and b.status in('committed','rolled_back')
 ) history),'[]'::jsonb),
 'documentContent',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'pages',(select jsonb_agg(jsonb_build_object('page',page->'page','label',page->'label','text',left(page->>'text',1000))) from(select value as page from jsonb_array_elements(d.content->'pages') limit 3) snippets))) from(select * from laras.documents where owner_id=p_owner and status='committed' and type not in ('CSV','XLSX') order by created_at desc limit 20) d),'[]'::jsonb),
 'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'sku',o.sku,'date',o.date,'product',o.product,'quantity',o.quantity,'unit_price',o.unit_price,'discount',o.discount,'total',o.total,'status',o.status,'channel',o.channel,'source',s.name,'sourceId',s.id,'row',o.source_row,'part',o.source_part,'batch',o.batch) order by o.date,o.id,o.sku) from laras.orders o join laras.sources s on s.id=o.source_id and s.owner_id=o.owner_id where o.owner_id=p_owner),'[]'::jsonb)
 );
$$;

create or replace function laras.commit_batch(p_owner text,p jsonb)
returns jsonb language plpgsql set search_path=pg_catalog,laras as $$
declare w laras.workspaces;b laras.upload_batches;doc record;s uuid;created_sources jsonb='[]';before_data jsonb;inventory_before jsonb;production_before jsonb;datasets_before jsonb;
begin
 if p->'approved' is distinct from 'true'::jsonb then return laras.failure('APPROVAL_REQUIRED','Persetujuan impor diperlukan.',422);end if;
 select * into w from laras.workspaces where owner_id=p_owner for update;
 select * into b from laras.upload_batches where owner_id=p_owner and id=(p->>'id')::uuid for update;
 if not found then return laras.failure('NOT_FOUND','Kelompok dokumen tidak ditemukan.',404);end if;
 if b.status='rolled_back' then return laras.failure('IMPORT_ROLLED_BACK','Impor ini telah dibatalkan.');end if;
 if b.status='committed' then return jsonb_build_object('id',b.id,'added',b.added,'updated',b.updated,'unchanged',b.unchanged,'revision',b.committed_revision);end if;
 if b.expires_at<now() then return laras.failure('PREVIEW_EXPIRED','Pratinjau kedaluwarsa. Tinjau kembali dokumen.');end if;
 if (select count(*) from laras.documents d join jsonb_to_recordset(b.documents) j(id uuid) on d.id=j.id where d.owner_id=p_owner)<>jsonb_array_length(b.documents) or exists(select 1 from laras.documents d join jsonb_to_recordset(b.documents) j(id uuid) on d.id=j.id where d.owner_id=p_owner and d.status='staged' and d.expires_at<now()) then return laras.failure('DOCUMENT_EXPIRED','Dokumen kedaluwarsa. Unggah kembali.');end if;
 if b.base_revision<>w.revision then return laras.failure('REVISION_CONFLICT','Data telah berubah. Tinjau ulang kelompok dokumen.');end if;
 select coalesce(jsonb_agg(to_jsonb(o)),'[]') into before_data from laras.orders o
 join jsonb_to_recordset(b.rows) as r(id text,sku text,date date,product text,quantity integer,unit_price numeric,discount numeric,total numeric,status text,channel text)
 on o.id=r.id and o.sku=r.sku where o.owner_id=p_owner and (o.date,o.product,o.quantity,o.unit_price,o.discount,o.total,o.status,o.channel) is distinct from (r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel);
 select coalesce(jsonb_agg(to_jsonb(o)),'[]') into inventory_before from laras.inventory o join jsonb_to_recordset(coalesce(b.catalog->'inventory','[]')) as r(sku text,name text,variant text,stock integer,minimum integer) on o.sku=r.sku where o.owner_id=p_owner and (o.name,o.variant,o.stock,o.minimum) is distinct from (r.name,r.variant,r.stock,r.minimum);
 select coalesce(jsonb_agg(to_jsonb(o)),'[]') into production_before from laras.production o join jsonb_to_recordset(coalesce(b.catalog->'production','[]')) as r(id text,name text,variant text,qty integer,completed integer,stage integer,target date,supplier text) on o.id=r.id where o.owner_id=p_owner and (o.name,o.variant,o.qty,o.completed,o.stage,o.target,o.supplier) is distinct from (r.name,r.variant,r.qty,r.completed,r.stage,r.target,r.supplier);
 select coalesce(jsonb_agg(to_jsonb(d)),'[]') into datasets_before from laras.datasets d join jsonb_to_recordset(b.datasets) as j("documentId" uuid,"partId" text) on d.document_id=j."documentId" and d.part_id=j."partId" where d.owner_id=p_owner;
 for doc in select d.* from laras.documents d join jsonb_to_recordset(b.documents) as j(id uuid) on j.id=d.id where d.owner_id=p_owner loop
  select id into s from laras.sources where owner_id=p_owner and document_id=doc.id;
  if not found then
   insert into laras.sources(owner_id,name,domain,rows_count,size_bytes,status,file_type,document_id)
   values(p_owner,doc.name,coalesce((select r->>'domain' from jsonb_array_elements(b.documents) r where r->>'id'=doc.id::text),'Dokumen'),(select (r->>'rows')::integer from jsonb_array_elements(b.documents) r where r->>'id'=doc.id::text),doc.size,case when doc.type not in ('CSV','XLSX') then 'Perlu review' else 'Terhubung' end,doc.type,doc.id) returning id into s;
   created_sources=created_sources||jsonb_build_array(s);
  end if;
  insert into laras.orders(owner_id,id,sku,date,product,quantity,unit_price,discount,total,status,channel,source_id,source_row,source_part,batch)
  select p_owner,r.id,r.sku,r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel,s,r.row,r.part,b.id
  from jsonb_to_recordset(b.rows) as r(id text,sku text,date date,product text,quantity integer,unit_price numeric,discount numeric,total numeric,status text,channel text,row integer,part text,"documentId" uuid) where r."documentId"=doc.id
  on conflict(owner_id,id,sku) do update set date=excluded.date,product=excluded.product,quantity=excluded.quantity,unit_price=excluded.unit_price,discount=excluded.discount,total=excluded.total,status=excluded.status,channel=excluded.channel,source_id=excluded.source_id,source_row=excluded.source_row,source_part=excluded.source_part,batch=excluded.batch
  where(orders.date,orders.product,orders.quantity,orders.unit_price,orders.discount,orders.total,orders.status,orders.channel) is distinct from (excluded.date,excluded.product,excluded.quantity,excluded.unit_price,excluded.discount,excluded.total,excluded.status,excluded.channel);
  insert into laras.inventory(owner_id,sku,name,variant,stock,minimum,source,source_row,source_id,source_part,batch)
  select p_owner,r.sku,r.name,r.variant,r.stock,r.minimum,doc.name,r.source_row,s,r.part,b.id from jsonb_to_recordset(coalesce(b.catalog->'inventory','[]')) as r(sku text,name text,variant text,stock integer,minimum integer,source_row integer,part text,"documentId" uuid) where r."documentId"=doc.id
  on conflict(owner_id,sku) do update set name=excluded.name,variant=excluded.variant,stock=excluded.stock,minimum=excluded.minimum,source=excluded.source,source_row=excluded.source_row,source_id=excluded.source_id,source_part=excluded.source_part,batch=excluded.batch
  where(inventory.name,inventory.variant,inventory.stock,inventory.minimum) is distinct from (excluded.name,excluded.variant,excluded.stock,excluded.minimum);
  insert into laras.production(owner_id,id,name,variant,qty,completed,stage,target,supplier,source,source_row,source_id,source_part,batch)
  select p_owner,r.id,r.name,r.variant,r.qty,r.completed,r.stage,r.target,r.supplier,doc.name,r.source_row,s,r.part,b.id from jsonb_to_recordset(coalesce(b.catalog->'production','[]')) as r(id text,name text,variant text,qty integer,completed integer,stage integer,target date,supplier text,source_row integer,part text,"documentId" uuid) where r."documentId"=doc.id
  on conflict(owner_id,id) do update set name=excluded.name,variant=excluded.variant,qty=excluded.qty,completed=excluded.completed,stage=excluded.stage,target=excluded.target,supplier=excluded.supplier,source=excluded.source,source_row=excluded.source_row,source_id=excluded.source_id,source_part=excluded.source_part,batch=excluded.batch
  where(production.name,production.variant,production.qty,production.completed,production.stage,production.target,production.supplier) is distinct from (excluded.name,excluded.variant,excluded.qty,excluded.completed,excluded.stage,excluded.target,excluded.supplier);
  insert into laras.datasets(owner_id,document_id,source_id,part_id,part_name,domain,columns,row_count,batch)
  select p_owner,doc.id,s,j."partId",j.part,j.domain,j.columns,j."rowCount",b.id from jsonb_to_recordset(b.datasets) as j("documentId" uuid,"partId" text,part text,domain text,columns jsonb,"rowCount" integer) where j."documentId"=doc.id
  on conflict(owner_id,document_id,part_id) do update set source_id=excluded.source_id,part_name=excluded.part_name,domain=excluded.domain,columns=excluded.columns,row_count=excluded.row_count,batch=excluded.batch
  where(datasets.domain,datasets.columns,datasets.row_count) is distinct from (excluded.domain,excluded.columns,excluded.row_count);
  update laras.documents set status='committed' where id=doc.id and owner_id=p_owner;
 end loop;
 update laras.workspaces set revision=revision+1 where owner_id=p_owner returning * into w;
 update laras.upload_batches set status='committed',committed_at=now(),committed_revision=w.revision,before_rows=before_data,before_inventory=inventory_before,before_production=production_before,before_datasets=datasets_before,source_ids=created_sources where id=b.id;
 insert into laras.audit_log(owner_id,action,entity_id,metadata) values(p_owner,'batch.committed',b.id::text,jsonb_build_object('documents',jsonb_array_length(b.documents),'added',b.added,'updated',b.updated,'revision',w.revision));
 return jsonb_build_object('id',b.id,'added',b.added,'updated',b.updated,'unchanged',b.unchanged,'revision',w.revision);
end$$;
commit;
