begin;
create table if not exists laras.documents(
 id uuid primary key default gen_random_uuid(),owner_id text not null references laras.workspaces,
 request_key text not null,name text not null,type text not null check(type in ('CSV','XLSX','PDF')),
 size integer not null check(size between 1 and 2000000),hash text not null,original text not null,content jsonb not null,
 status text not null default 'staged' check(status in ('staged','committed')),created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '24 hours',unique(owner_id,request_key),unique(owner_id,id)
);
create index if not exists laras_documents_hash on laras.documents(owner_id,hash,status);
alter table laras.documents enable row level security;
alter table laras.sources add column if not exists file_type text not null default 'CSV';
alter table laras.sources add column if not exists document_id uuid;
do $$begin
 if not exists(select 1 from pg_constraint where conname='laras_sources_document_fk' and conrelid='laras.sources'::regclass) then
  alter table laras.sources add constraint laras_sources_document_fk foreign key(owner_id,document_id) references laras.documents(owner_id,id);
 end if;
end$$;
alter table laras.orders add column if not exists source_part text;
alter table laras.inventory add column if not exists source_id uuid;
alter table laras.inventory add column if not exists source_part text;
alter table laras.inventory add column if not exists batch uuid;
alter table laras.production add column if not exists source_id uuid;
alter table laras.production add column if not exists source_row integer;
alter table laras.production add column if not exists source_part text;
alter table laras.production add column if not exists batch uuid;
alter table laras.workspaces alter column name set default 'Ruang kerja';
create table if not exists laras.datasets(
 id uuid primary key default gen_random_uuid(),owner_id text not null references laras.workspaces,
 document_id uuid not null,source_id uuid not null,part_id text not null,part_name text not null default '',domain text not null,
 columns jsonb not null,row_count integer not null,batch uuid not null,created_at timestamptz not null default now(),
 unique(owner_id,document_id,part_id),foreign key(owner_id,document_id) references laras.documents(owner_id,id),foreign key(owner_id,source_id) references laras.sources(owner_id,id)
);
alter table laras.datasets enable row level security;
create table if not exists laras.upload_batches(
 id uuid primary key default gen_random_uuid(),owner_id text not null references laras.workspaces,
 request_key text not null,request_hash text not null,documents jsonb not null,rows jsonb not null,catalog jsonb not null default '{}',datasets jsonb not null default '[]',
 base_revision bigint not null,committed_revision bigint,before_rows jsonb,before_inventory jsonb,before_production jsonb,before_datasets jsonb,source_ids jsonb,
 added integer not null,updated integer not null,unchanged integer not null,
 status text not null default 'preview' check(status in ('preview','committed','rolled_back')),
 created_at timestamptz not null default now(),committed_at timestamptz,expires_at timestamptz not null default now()+interval '1 hour',
 unique(owner_id,request_key)
);
alter table laras.upload_batches enable row level security;

create or replace function laras.snapshot_v2(p_owner text,p_days integer)
returns jsonb language sql stable set search_path=pg_catalog,laras as $$
 select laras.snapshot(p_owner,p_days)||jsonb_build_object(
 'datasets',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name',s.name,'label',s.name||case when d.part_name<>'' then ' · '||d.part_name else '' end,'part_name',d.part_name,'domain',d.domain,'row_count',d.row_count,'columns',d.columns,'document_id',d.document_id,'source_id',d.source_id) order by d.created_at desc,d.id) from laras.datasets d join laras.sources s on s.id=d.source_id and s.owner_id=d.owner_id where d.owner_id=p_owner),'[]'::jsonb),
 'files',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'type',s.file_type,'domain',s.domain,'rows',s.rows_count,'status',s.status,'date',s.created_at,'size',s.size_bytes,'documentId',s.document_id,'pages',(select coalesce(jsonb_array_length(f.content->'pages'),0) from laras.documents f where f.id=s.document_id and f.owner_id=s.owner_id)) order by s.created_at) from laras.sources s where s.owner_id=p_owner),'[]'::jsonb),
 'history',coalesce((select jsonb_agg(h order by h->>'date',h->>'id') from(
  select jsonb_build_object('id',i.id,'name',i.name,'date',i.committed_at,'added',i.added,'updated',i.updated,'unchanged',i.unchanged,'rolledBack',i.status='rolled_back','revision',i.committed_revision,'kind','legacy') h from laras.imports i where i.owner_id=p_owner and i.status in('committed','rolled_back')
  union all select jsonb_build_object('id',b.id,'name',jsonb_array_length(b.documents)||' dokumen','date',b.committed_at,'added',b.added,'updated',b.updated,'unchanged',b.unchanged,'rolledBack',b.status='rolled_back','revision',b.committed_revision,'kind','batch') from laras.upload_batches b where b.owner_id=p_owner and b.status in('committed','rolled_back')
 ) history),'[]'::jsonb),
 'documentContent',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'pages',(select jsonb_agg(jsonb_build_object('page',page->'page','text',left(page->>'text',1000))) from(select value as page from jsonb_array_elements(d.content->'pages') limit 3) snippets))) from(select * from laras.documents where owner_id=p_owner and status='committed' and type='PDF' order by created_at desc limit 20) d),'[]'::jsonb),
 'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'sku',o.sku,'date',o.date,'product',o.product,'quantity',o.quantity,'unit_price',o.unit_price,'discount',o.discount,'total',o.total,'status',o.status,'channel',o.channel,'source',s.name,'sourceId',s.id,'row',o.source_row,'part',o.source_part,'batch',o.batch) order by o.date,o.id,o.sku) from laras.orders o join laras.sources s on s.id=o.source_id and s.owner_id=o.owner_id where o.owner_id=p_owner),'[]'::jsonb)
 );
$$;

create or replace function laras.catalog_counts(p_owner text,p jsonb)
returns jsonb language sql stable set search_path=pg_catalog,laras as $$
 with records as(
 select o.sku is null as added,(o.name,o.variant,o.stock,o.minimum) is distinct from (r.name,r.variant,r.stock,r.minimum) as changed
 from jsonb_to_recordset(coalesce(p->'inventory','[]')) as r(sku text,name text,variant text,stock integer,minimum integer)
 left join laras.inventory o on o.owner_id=p_owner and o.sku=r.sku
 union all
 select o.id is null,(o.name,o.variant,o.qty,o.completed,o.stage,o.target,o.supplier) is distinct from (r.name,r.variant,r.qty,r.completed,r.stage,r.target,r.supplier)
 from jsonb_to_recordset(coalesce(p->'production','[]')) as r(id text,name text,variant text,qty integer,completed integer,stage integer,target date,supplier text)
 left join laras.production o on o.owner_id=p_owner and o.id=r.id
 )select jsonb_build_object('added',count(*) filter(where added),'updated',count(*) filter(where not added and changed),'unchanged',count(*) filter(where not added and not changed)) from records;
$$;

create or replace function laras.preview_batch(p_owner text,p jsonb)
returns jsonb language plpgsql set search_path=pg_catalog,laras as $$
declare w laras.workspaces;b laras.upload_batches;a integer;u integer;n integer;c jsonb;g record;existing laras.datasets;
begin
 select * into w from laras.workspaces where owner_id=p_owner for update;
 select * into b from laras.upload_batches where owner_id=p_owner and request_key=p->>'requestKey';
 if found then
  if b.request_hash<>p->>'hash' then return laras.failure('IDEMPOTENCY_CONFLICT','ID permintaan telah digunakan.');end if;
  if b.status<>'preview' or b.expires_at<now() then return laras.failure('PREVIEW_EXPIRED','Pratinjau kedaluwarsa. Tinjau kembali dokumen.');end if;
 else
  delete from laras.upload_batches where owner_id=p_owner and status='preview' and expires_at<now();
  if(select count(*) from laras.upload_batches where owner_id=p_owner and status='preview')>=20 then return laras.failure('PREVIEW_LIMIT','Terlalu banyak pratinjau aktif.',429);end if;
  if (select count(*) from jsonb_to_recordset(p->'documents') as d(id uuid) join laras.documents s on s.id=d.id and s.owner_id=p_owner)<>jsonb_array_length(p->'documents') then return laras.failure('DOCUMENT_NOT_FOUND','Dokumen tidak ditemukan.',404);end if;
  select count(*) filter(where o.id is null),count(*) filter(where o.id is not null and
  (o.date,o.product,o.quantity,o.unit_price,o.discount,o.total,o.status,o.channel) is distinct from (r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel)),count(*) filter(where o.id is not null and
  (o.date,o.product,o.quantity,o.unit_price,o.discount,o.total,o.status,o.channel) is not distinct from (r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel)) into a,u,n
  from jsonb_to_recordset(p->'rows') as r(id text,sku text,date date,product text,quantity integer,unit_price numeric,discount numeric,total numeric,status text,channel text)
  left join laras.orders o on o.owner_id=p_owner and o.id=r.id and o.sku=r.sku;
  if(select count(*) from laras.orders where owner_id=p_owner)+a>20000 then return laras.failure('WORKSPACE_ROW_LIMIT','Batas versi awal adalah 20.000 baris penjualan.',422);end if;
  for g in select * from jsonb_to_recordset(coalesce(p->'datasets','[]')) as x("documentId" uuid,"partId" text,domain text,columns jsonb,"rowCount" integer) where domain='dataset' loop
   select * into existing from laras.datasets where owner_id=p_owner and document_id=g."documentId" and part_id=g."partId";
   if not found then a=a+g."rowCount";elsif(existing.domain,existing.columns) is distinct from (g.domain,g.columns) then u=u+g."rowCount";else n=n+g."rowCount";end if;
  end loop;
  c=laras.catalog_counts(p_owner,coalesce(p->'catalog','{}'));
  insert into laras.upload_batches(owner_id,request_key,request_hash,documents,rows,catalog,datasets,base_revision,added,updated,unchanged)
  values(p_owner,p->>'requestKey',p->>'hash',p->'documents',p->'rows',coalesce(p->'catalog','{}'),coalesce(p->'datasets','[]'),w.revision,a+(c->>'added')::integer,u+(c->>'updated')::integer,n+(c->>'unchanged')::integer+coalesce((p->>'duplicates')::integer,0)) returning * into b;
 end if;
 return jsonb_build_object('id',b.id,'added',b.added,'updated',b.updated,'unchanged',b.unchanged,'revision',b.base_revision,'documents',b.documents,'expiresAt',b.expires_at);
end$$;

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
   values(p_owner,doc.name,coalesce((select r->>'domain' from jsonb_array_elements(b.documents) r where r->>'id'=doc.id::text),'Dokumen'),(select (r->>'rows')::integer from jsonb_array_elements(b.documents) r where r->>'id'=doc.id::text),doc.size,case when doc.type='PDF' then 'Perlu review' else 'Terhubung' end,doc.type,doc.id) returning id into s;
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

create or replace function laras.rollback_latest(p_owner text,p jsonb)
returns jsonb language plpgsql set search_path=pg_catalog,laras as $$
declare w laras.workspaces;b laras.upload_batches;latest uuid;result jsonb;previous record;
begin
 select * into w from laras.workspaces where owner_id=p_owner for update;
 select * into b from laras.upload_batches where owner_id=p_owner and id=(p->>'id')::uuid for update;
 if found and b.status='rolled_back' then return jsonb_build_object('id',b.id,'rolledBack',true,'revision',w.revision);end if;
 select id into latest from(select id,base_revision from laras.upload_batches where owner_id=p_owner and status='committed' union all select id,base_revision from laras.imports where owner_id=p_owner and status='committed') h order by base_revision desc limit 1;
 if latest is distinct from (p->>'id')::uuid then
  if not exists(select 1 from laras.upload_batches where owner_id=p_owner and id=(p->>'id')::uuid) and not exists(select 1 from laras.imports where owner_id=p_owner and id=(p->>'id')::uuid) then return laras.failure('NOT_FOUND','Impor tidak ditemukan.',404);end if;
  return laras.failure('REVISION_CONFLICT','Hanya impor terbaru yang dapat dibatalkan.');
 end if;
 if b.id is null then
  result=laras.rollback_import(p_owner,p);if result ? 'error' then return result;end if;
 else
  if b.committed_revision<>w.revision then return laras.failure('REVISION_CONFLICT','Data telah berubah sejak impor ini.');end if;
  delete from laras.orders where owner_id=p_owner and batch=b.id;
  insert into laras.orders select * from jsonb_populate_recordset(null::laras.orders,b.before_rows)
  on conflict(owner_id,id,sku) do update set date=excluded.date,product=excluded.product,quantity=excluded.quantity,unit_price=excluded.unit_price,discount=excluded.discount,total=excluded.total,status=excluded.status,channel=excluded.channel,source_id=excluded.source_id,source_row=excluded.source_row,source_part=excluded.source_part,batch=excluded.batch;
  delete from laras.inventory where owner_id=p_owner and batch=b.id;
  insert into laras.inventory select * from jsonb_populate_recordset(null::laras.inventory,b.before_inventory)
  on conflict(owner_id,sku) do update set name=excluded.name,variant=excluded.variant,stock=excluded.stock,minimum=excluded.minimum,source=excluded.source,source_row=excluded.source_row,source_id=excluded.source_id,source_part=excluded.source_part,batch=excluded.batch;
  delete from laras.production where owner_id=p_owner and batch=b.id;
  insert into laras.production select * from jsonb_populate_recordset(null::laras.production,b.before_production)
  on conflict(owner_id,id) do update set name=excluded.name,variant=excluded.variant,qty=excluded.qty,completed=excluded.completed,stage=excluded.stage,target=excluded.target,supplier=excluded.supplier,source=excluded.source,source_row=excluded.source_row,source_id=excluded.source_id,source_part=excluded.source_part,batch=excluded.batch;
  delete from laras.datasets where owner_id=p_owner and batch=b.id;
  insert into laras.datasets select * from jsonb_populate_recordset(null::laras.datasets,b.before_datasets)
  on conflict(owner_id,document_id,part_id) do update set source_id=excluded.source_id,part_name=excluded.part_name,domain=excluded.domain,columns=excluded.columns,row_count=excluded.row_count,batch=excluded.batch;
  update laras.documents set status='staged',expires_at=now()+interval '24 hours' where owner_id=p_owner and id in(select document_id from laras.sources where owner_id=p_owner and id in(select value::text::uuid from jsonb_array_elements_text(b.source_ids))) and status='committed';
  delete from laras.sources where owner_id=p_owner and id in(select value::text::uuid from jsonb_array_elements_text(b.source_ids));
  update laras.upload_batches set status='rolled_back' where id=b.id;
  update laras.workspaces set revision=revision+1 where owner_id=p_owner returning * into w;
  insert into laras.audit_log(owner_id,action,entity_id) values(p_owner,'batch.rolled_back',b.id::text);
  result=jsonb_build_object('id',b.id,'rolledBack',true,'revision',w.revision);
 end if;
 select id,kind into previous from(select id,'batch' kind,base_revision from laras.upload_batches where owner_id=p_owner and status='committed' union all select id,'legacy',base_revision from laras.imports where owner_id=p_owner and status='committed') h order by base_revision desc limit 1;
 if found then
  if previous.kind='batch' then update laras.upload_batches set committed_revision=(select revision from laras.workspaces where owner_id=p_owner) where id=previous.id;
  else update laras.imports set committed_revision=(select revision from laras.workspaces where owner_id=p_owner) where id=previous.id;end if;
 end if;
 return result;
end$$;

create or replace function public.laras_batch_rpc(p_owner text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog,laras as $$
declare d laras.documents;result jsonb;
begin
 if p_owner is null or length(p_owner) not between 1 and 200 then return laras.failure('AUTH_REQUIRED','Identitas diperlukan.',401);end if;
 insert into laras.workspaces(owner_id) values(p_owner) on conflict do nothing;
 case p_action
 when 'bootstrap' then
  if coalesce((p_payload->>'days')::integer,21) not between 1 and 366 then return laras.failure('INVALID_PERIOD','Periode tidak valid.',422);end if;
  return laras.snapshot_v2(p_owner,coalesce((p_payload->>'days')::integer,21));
 when 'dataset_get' then
  select jsonb_build_object('id',t.id,'name',s.name,'label',s.name||case when t.part_name<>'' then ' · '||t.part_name else '' end,'part_name',t.part_name,'domain',t.domain,'columns',t.columns,'document_id',t.document_id,'source_id',t.source_id,'headers',part->'headers','rows',part->'rows') into result
  from laras.datasets t join laras.sources s on s.id=t.source_id and s.owner_id=t.owner_id join laras.documents f on f.id=t.document_id and f.owner_id=t.owner_id cross join lateral jsonb_array_elements(f.content->'tables') part
  where t.owner_id=p_owner and t.id=(p_payload->>'id')::uuid and part->>'id'=t.part_id;
  if result is null then return laras.failure('NOT_FOUND','Set data tidak ditemukan.',404);end if;return result;
 when 'document_stage' then
  perform 1 from laras.workspaces where owner_id=p_owner for update;
  select * into d from laras.documents where owner_id=p_owner and request_key=p_payload->>'requestKey';
  if found then
   if d.hash<>p_payload->>'hash' or d.name<>p_payload->>'name' then return laras.failure('IDEMPOTENCY_CONFLICT','ID permintaan telah digunakan.');end if;
   return to_jsonb(d)-'original'-'owner_id';
  end if;
  select * into d from laras.documents where owner_id=p_owner and hash=p_payload->>'hash' and (status='committed' or expires_at>now()) order by (status='committed') desc limit 1;
  if found then return to_jsonb(d)-'original'-'owner_id';end if;
  delete from laras.documents where owner_id=p_owner and status='staged' and expires_at<now();
  if(select count(*) from laras.documents where owner_id=p_owner and status='staged')>=20 then return laras.failure('FILE_LIMIT','Maksimal 20 dokumen menunggu impor.',429);end if;
  insert into laras.documents(owner_id,request_key,name,type,size,hash,original,content) values(p_owner,p_payload->>'requestKey',p_payload->>'name',p_payload->>'type',(p_payload->>'size')::integer,p_payload->>'hash',p_payload->>'original',p_payload->'content') returning * into d;
  return to_jsonb(d)-'original'-'owner_id';
 when 'document_get' then
  select * into d from laras.documents where owner_id=p_owner and id=(p_payload->>'id')::uuid;
  if not found then return laras.failure('NOT_FOUND','Dokumen tidak ditemukan.',404);end if;
  return to_jsonb(d)-'owner_id';
 when 'document_remove' then
  select * into d from laras.documents where owner_id=p_owner and id=(p_payload->>'id')::uuid for update;
  if not found then return jsonb_build_object('deleted',true);end if;
  if d.status='committed' then return laras.failure('DOCUMENT_COMMITTED','Dokumen yang sudah diimpor tetap tersimpan.');end if;
  delete from laras.documents where owner_id=p_owner and id=d.id;return jsonb_build_object('deleted',true);
 when 'documents_get' then
  select coalesce(jsonb_agg(to_jsonb(item)-'original'-'owner_id'),'[]') into result from laras.documents item where item.owner_id=p_owner and item.id in(select value::text::uuid from jsonb_array_elements_text(p_payload->'ids'));
  return jsonb_build_object('documents',result);
 when 'batch_preview' then return laras.preview_batch(p_owner,p_payload);
 when 'commit' then
  result=laras.commit_import(p_owner,p_payload);
  if not(result ? 'error') then update laras.orders set source_part=null where owner_id=p_owner and batch=(p_payload->>'id')::uuid;end if;
  return result;
 when 'catalog' then
  result=laras.save_catalog(p_owner,p_payload);if result ? 'error' then return result;end if;
  if p_payload->>'domain'='inventory' then update laras.inventory set source_id=null,source_part=null,batch=null where owner_id=p_owner and sku in(select value->>'sku' from jsonb_array_elements(p_payload->'rows'));
  else update laras.production set source_id=null,source_part=null,batch=null where owner_id=p_owner and id in(select value->>'id' from jsonb_array_elements(p_payload->'rows'));end if;
  return result;
 when 'batch_commit' then return laras.commit_batch(p_owner,p_payload);
 when 'rollback' then return laras.rollback_latest(p_owner,p_payload);
 else return laras.failure('ACTION_NOT_FOUND','Operasi tidak tersedia.',404);
 end case;
end$$;
revoke all on function public.laras_batch_rpc(text,text,jsonb) from public;
do $$begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on function public.laras_batch_rpc(text,text,jsonb) from anon;end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on function public.laras_batch_rpc(text,text,jsonb) from authenticated;end if;
 if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.laras_batch_rpc(text,text,jsonb) to service_role;end if;
end$$;
insert into laras.schema_versions(version) values(2) on conflict do nothing;
notify pgrst,'reload schema';
commit;
