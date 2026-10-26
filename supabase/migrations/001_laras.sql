-- Laras owns only its schema and the public RPC below. Never alters unrelated tables.
begin;
create schema if not exists laras;
revoke all on schema laras from public;
create table if not exists laras.schema_versions(version integer primary key, applied_at timestamptz not null default now());

create table if not exists laras.workspaces(
  owner_id text primary key check(length(owner_id) between 1 and 200),
  name text not null default 'Nusa Studio' check(length(name) between 1 and 80),
  currency text not null default 'IDR' check(currency='IDR'),
  revision bigint not null default 0,
  preferences jsonb not null default '{"daily":true,"stock":true,"production":true}',
  created_at timestamptz not null default now()
);
create table if not exists laras.sources(
  id uuid primary key default gen_random_uuid(),owner_id text not null references laras.workspaces,
  name text not null,domain text not null default 'Penjualan',rows_count integer not null,
  size_bytes integer not null default 0,status text not null default 'Terhubung',created_at timestamptz not null default now(),
  unique(owner_id,id)
);
create table if not exists laras.orders(
  owner_id text not null references laras.workspaces, id text not null,sku text not null,
  date date not null,product text not null,quantity integer not null check(quantity>0),
  unit_price numeric(18,2) not null check(unit_price>=0),discount numeric(18,2) not null check(discount>=0),
  total numeric(18,2) not null check(total>=0),status text not null,channel text not null,
  source_id uuid not null,source_row integer not null check(source_row>=2),batch uuid not null,
  primary key(owner_id,id,sku),foreign key(owner_id,source_id) references laras.sources(owner_id,id)
);
create index if not exists laras_orders_date on laras.orders(owner_id,date);
create index if not exists laras_orders_source on laras.orders(owner_id,source_id);
create table if not exists laras.imports(
  id uuid primary key default gen_random_uuid(),owner_id text not null references laras.workspaces,
  request_key text not null,request_hash text not null,name text not null,size_bytes integer not null,
  rows jsonb not null,mapping jsonb not null,status text not null default 'preview' check(status in ('preview','committed','rolled_back')),
  base_revision bigint not null,committed_revision bigint,before_rows jsonb,source_id uuid,
  added integer not null,updated integer not null,unchanged integer not null,
  created_at timestamptz not null default now(),committed_at timestamptz,expires_at timestamptz not null default now()+interval '1 hour',
  unique(owner_id,request_key)
);
create index if not exists laras_imports_owner on laras.imports(owner_id,created_at desc);
create table if not exists laras.inventory(
  owner_id text not null references laras.workspaces,sku text not null,name text not null,variant text not null default '',
  stock integer not null check(stock>=0),minimum integer not null check(minimum>=0),
  source text not null default 'API',source_row integer not null default 0,
  primary key(owner_id,sku)
);
create table if not exists laras.production(
  owner_id text not null references laras.workspaces,id text not null,name text not null,variant text not null default '',
  qty integer not null check(qty>0),completed integer not null check(completed between 0 and qty),
  stage integer not null check(stage between 0 and 3),target date not null,supplier text not null,
  source text not null default 'API',primary key(owner_id,id)
);
create table if not exists laras.reviews(
  owner_id text not null references laras.workspaces,fingerprint text not null,reviewed_at timestamptz not null default now(),
  primary key(owner_id,fingerprint)
);
create table if not exists laras.chats(
  id uuid primary key default gen_random_uuid(),owner_id text not null references laras.workspaces,
  request_key text not null,request_hash text not null,question text not null,answer jsonb,
  created_at timestamptz not null default now(),unique(owner_id,request_key)
);
create index if not exists laras_chats_owner on laras.chats(owner_id,created_at desc);
create table if not exists laras.audit_log(
  id bigint generated always as identity primary key,owner_id text not null references laras.workspaces,
  action text not null,entity_id text,metadata jsonb not null default '{}',created_at timestamptz not null default now()
);

-- No direct browser access: service role alone may execute the public dispatcher.
do $$declare t record;begin
  for t in select tablename from pg_tables where schemaname='laras' loop
    execute format('alter table laras.%I enable row level security',t.tablename);
  end loop;
end$$;

create or replace function laras.failure(code text,message text,status integer default 409)
returns jsonb language sql immutable set search_path=pg_catalog as $$
  select jsonb_build_object('error',jsonb_build_object('code',code,'message',message,'status',status));
$$;

create or replace function laras.analytics(p_owner text,p_days integer)
returns jsonb language sql stable set search_path=pg_catalog,laras as $$
 with anchor as (select coalesce(max(date),(now() at time zone 'Asia/Jakarta')::date) as last_date from laras.orders where owner_id=p_owner),
 selected as(select o.* from laras.orders o,anchor a where owner_id=p_owner and date between a.last_date-(p_days-1) and a.last_date),
 daily as(select date,sum(total) as revenue,count(distinct id) as orders,sum(quantity) as units from selected group by date),
 channels as(select channel as name,sum(total) as total from selected group by channel),
 products as(select sku,max(product) as name,sum(quantity) as units,sum(total) as total from selected group by sku)
 select jsonb_build_object(
  'metrics',(select jsonb_build_object('revenue',coalesce(sum(total),0),'orders',count(distinct id),'units',coalesce(sum(quantity),0),'discount',coalesce(sum(discount),0)) from selected),
  'daily',coalesce((select jsonb_agg(to_jsonb(d) order by date) from daily d),'[]'::jsonb),
  'channels',coalesce((select jsonb_agg(to_jsonb(c) order by total desc,name) from channels c),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by total desc,sku) from products p),'[]'::jsonb),
  'period',(select jsonb_build_object('from',min(date),'to',max(date),'days',p_days) from selected),
  'sources',coalesce((select jsonb_agg(distinct jsonb_build_object('id',s.id,'name',s.name)) from selected o join laras.sources s on s.id=o.source_id and s.owner_id=p_owner),'[]'::jsonb),
  'rowCount',(select count(*) from selected),
  'inventory',(select jsonb_build_object('units',coalesce(sum(stock),0),'skus',count(*),'low',count(*) filter(where stock<minimum)) from laras.inventory where owner_id=p_owner),
  'production',(select jsonb_build_object('units',coalesce(sum(qty-completed),0),'active',count(*) filter(where completed<qty),'late',count(*) filter(where completed<qty and target<(now() at time zone 'Asia/Jakarta')::date)) from laras.production where owner_id=p_owner)
 );
$$;

create or replace function laras.snapshot(p_owner text,p_days integer)
returns jsonb language sql stable set search_path=pg_catalog,laras as $$
 select jsonb_build_object(
  'workspace',(select to_jsonb(w)-'owner_id' from laras.workspaces w where owner_id=p_owner),
  'orders',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'sku',o.sku,'date',o.date,'product',o.product,'quantity',o.quantity,'unit_price',o.unit_price,'discount',o.discount,'total',o.total,'status',o.status,'channel',o.channel,'source',s.name,'sourceId',s.id,'row',o.source_row,'batch',o.batch) order by o.date,o.id,o.sku) from laras.orders o join laras.sources s on s.id=o.source_id and s.owner_id=o.owner_id where o.owner_id=p_owner),'[]'::jsonb),
  'products',coalesce((select jsonb_agg(to_jsonb(i)-'owner_id' order by sku) from laras.inventory i where owner_id=p_owner),'[]'::jsonb),
  'production',coalesce((select jsonb_agg((to_jsonb(p)-'owner_id')||jsonb_build_object('status',case when completed<qty and target<(now() at time zone 'Asia/Jakarta')::date then 'Terlambat' when completed=qty then 'Selesai' else 'Berjalan' end) order by target,id) from laras.production p where owner_id=p_owner),'[]'::jsonb),
  'files',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'type',case when domain='Penjualan' then 'CSV' else 'API' end,'domain',domain,'rows',rows_count,'status',status,'date',created_at,'size',size_bytes) order by created_at) from laras.sources where owner_id=p_owner),'[]'::jsonb),
  'history',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'date',committed_at,'added',added,'updated',updated,'unchanged',unchanged,'rolledBack',status='rolled_back','revision',committed_revision) order by committed_at) from laras.imports where owner_id=p_owner and status in ('committed','rolled_back')),'[]'::jsonb),
  'reviewed',coalesce((select jsonb_agg(fingerprint) from laras.reviews where owner_id=p_owner),'[]'::jsonb),
  'dashboard',laras.analytics(p_owner,p_days)
 );
$$;

create or replace function laras.preview_import(p_owner text,p jsonb)
returns jsonb language plpgsql set search_path=pg_catalog,laras as $$
declare w laras.workspaces;i laras.imports;a integer;u integer;n integer;
begin
 select * into w from laras.workspaces where owner_id=p_owner for update;
 select * into i from laras.imports where owner_id=p_owner and request_key=p->>'requestKey';
 if found then
  if i.request_hash<>p->>'hash' then return laras.failure('IDEMPOTENCY_CONFLICT','ID permintaan telah digunakan.');end if;
  if i.status<>'preview' or i.expires_at<now() then return laras.failure('PREVIEW_EXPIRED','Pratinjau kedaluwarsa. Unggah kembali berkas.');end if;
 else
  delete from laras.imports where owner_id=p_owner and status='preview' and expires_at<now();
  if(select count(*) from laras.imports where owner_id=p_owner and status='preview')>=20 then
    return laras.failure('PREVIEW_LIMIT','Terlalu banyak pratinjau aktif. Coba kembali nanti.',429);
  end if;
  select count(*) filter(where o.id is null),count(*) filter(where o.id is not null and
     (o.date,o.product,o.quantity,o.unit_price,o.discount,o.total,o.status,o.channel) is distinct from
     (r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel)),count(*) filter(where o.id is not null and
     (o.date,o.product,o.quantity,o.unit_price,o.discount,o.total,o.status,o.channel) is not distinct from
     (r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel)) into a,u,n
  from jsonb_to_recordset(p->'rows') as r(id text,sku text,date date,product text,quantity integer,unit_price numeric,discount numeric,total numeric,status text,channel text)
  left join laras.orders o on o.owner_id=p_owner and o.id=r.id and o.sku=r.sku;
  if (select count(*) from laras.orders where owner_id=p_owner)+a>20000 then return laras.failure('WORKSPACE_ROW_LIMIT','Batas versi awal adalah 20.000 baris penjualan.',422);end if;
  insert into laras.imports(owner_id,request_key,request_hash,name,size_bytes,rows,mapping,base_revision,added,updated,unchanged)
  values(p_owner,p->>'requestKey',p->>'hash',p->>'name',(p->>'size')::integer,p->'rows',p->'mapping',w.revision,a,u,n) returning * into i;
 end if;
 return jsonb_build_object('id',i.id,'revision',i.base_revision,'expiresAt',i.expires_at,'added',i.added,'updated',i.updated,'unchanged',i.unchanged,
  'mapping',i.mapping,'sample',(select jsonb_agg(v) from(select value as v from jsonb_array_elements(i.rows) limit 5) x),'rowCount',jsonb_array_length(i.rows));
end$$;

create or replace function laras.commit_import(p_owner text,p jsonb)
returns jsonb language plpgsql set search_path=pg_catalog,laras as $$
declare w laras.workspaces;i laras.imports;s uuid;before_data jsonb;
begin
 if p->'approved' is distinct from 'true'::jsonb then return laras.failure('APPROVAL_REQUIRED','Persetujuan impor diperlukan.',422);end if;
 select * into w from laras.workspaces where owner_id=p_owner for update;
 select * into i from laras.imports where owner_id=p_owner and id=(p->>'id')::uuid for update;
 if not found then return laras.failure('NOT_FOUND','Pratinjau tidak ditemukan.',404);end if;
 if i.status='rolled_back' then return laras.failure('IMPORT_ROLLED_BACK','Impor ini telah dibatalkan.');end if;
 if i.status='committed' then return jsonb_build_object('id',i.id,'added',i.added,'updated',i.updated,'unchanged',i.unchanged,'revision',i.committed_revision);end if;
 if i.expires_at<now() then return laras.failure('PREVIEW_EXPIRED','Pratinjau kedaluwarsa. Unggah kembali berkas.');end if;
 if i.base_revision<>w.revision then return laras.failure('REVISION_CONFLICT','Data telah berubah. Tinjau kembali impor sebelum melanjutkan.');end if;
 -- Preserve the complete previous records, including source references, for exact rollback.
 select coalesce(jsonb_agg(to_jsonb(o)),'[]') into before_data from laras.orders o
 join jsonb_to_recordset(i.rows) as r(id text,sku text,date date,product text,quantity integer,unit_price numeric,discount numeric,total numeric,status text,channel text) on o.id=r.id and o.sku=r.sku where o.owner_id=p_owner and
 (o.date,o.product,o.quantity,o.unit_price,o.discount,o.total,o.status,o.channel) is distinct from (r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel);
 if i.added+i.updated>0 then
  insert into laras.sources(owner_id,name,rows_count,size_bytes) values(p_owner,i.name,jsonb_array_length(i.rows),i.size_bytes) returning id into s;
  insert into laras.orders(owner_id,id,sku,date,product,quantity,unit_price,discount,total,status,channel,source_id,source_row,batch)
  select p_owner,r.id,r.sku,r.date,r.product,r.quantity,r.unit_price,r.discount,r.total,r.status,r.channel,s,r.row,i.id
  from jsonb_to_recordset(i.rows) as r(id text,sku text,date date,product text,quantity integer,unit_price numeric,discount numeric,total numeric,status text,channel text,row integer)
  on conflict(owner_id,id,sku) do update set date=excluded.date,product=excluded.product,quantity=excluded.quantity,unit_price=excluded.unit_price,
    discount=excluded.discount,total=excluded.total,status=excluded.status,channel=excluded.channel,source_id=excluded.source_id,source_row=excluded.source_row,batch=excluded.batch
  where(orders.date,orders.product,orders.quantity,orders.unit_price,orders.discount,orders.total,orders.status,orders.channel) is distinct from
    (excluded.date,excluded.product,excluded.quantity,excluded.unit_price,excluded.discount,excluded.total,excluded.status,excluded.channel);
 end if;
 update laras.workspaces set revision=revision+1 where owner_id=p_owner returning * into w;
 update laras.imports set status='committed',before_rows=before_data,source_id=s,committed_revision=w.revision,committed_at=now() where id=i.id;
 insert into laras.audit_log(owner_id,action,entity_id,metadata) values(p_owner,'import.committed',i.id::text,jsonb_build_object('added',i.added,'updated',i.updated,'unchanged',i.unchanged,'revision',w.revision));
 return jsonb_build_object('id',i.id,'added',i.added,'updated',i.updated,'unchanged',i.unchanged,'revision',w.revision);
end$$;

create or replace function laras.rollback_import(p_owner text,p jsonb)
returns jsonb language plpgsql set search_path=pg_catalog,laras as $$
declare w laras.workspaces;i laras.imports;
begin
 select * into w from laras.workspaces where owner_id=p_owner for update;
 select * into i from laras.imports where owner_id=p_owner and id=(p->>'id')::uuid for update;
 if not found then return laras.failure('NOT_FOUND','Impor tidak ditemukan.',404);end if;
 if i.status='rolled_back' then return jsonb_build_object('id',i.id,'rolledBack',true,'revision',w.revision);end if;
 if i.status<>'committed' then return laras.failure('IMPORT_NOT_COMMITTED','Impor belum diterapkan.');end if;
 if i.committed_revision<>w.revision then return laras.failure('REVISION_CONFLICT','Hanya perubahan terbaru yang dapat dibatalkan.');end if;
 delete from laras.orders where owner_id=p_owner and batch=i.id;
 insert into laras.orders select * from jsonb_populate_recordset(null::laras.orders,i.before_rows)
 on conflict(owner_id,id,sku) do update set date=excluded.date,product=excluded.product,quantity=excluded.quantity,unit_price=excluded.unit_price,
 discount=excluded.discount,total=excluded.total,status=excluded.status,channel=excluded.channel,source_id=excluded.source_id,source_row=excluded.source_row,batch=excluded.batch;
 if i.source_id is not null then delete from laras.sources where owner_id=p_owner and id=i.source_id;end if;
 update laras.imports set status='rolled_back' where id=i.id;
 update laras.workspaces set revision=revision+1 where owner_id=p_owner returning * into w;
 -- After restoring the latest import, its predecessor becomes the latest sales change.
 update laras.imports set committed_revision=w.revision where id=(select id from laras.imports where owner_id=p_owner and status='committed' order by committed_at desc,id desc limit 1);
 insert into laras.audit_log(owner_id,action,entity_id) values(p_owner,'import.rolled_back',i.id::text);
 return jsonb_build_object('id',i.id,'rolledBack',true,'revision',w.revision);
end$$;

create or replace function laras.save_catalog(p_owner text,p jsonb)
returns jsonb language plpgsql set search_path=pg_catalog,laras as $$
declare rev bigint; n integer;
begin
 select revision into rev from laras.workspaces where owner_id=p_owner for update;
 if rev<>(p->>'revision')::bigint then return laras.failure('REVISION_CONFLICT','Data telah berubah. Muat ulang sebelum menyimpan.');end if;
 if p->>'domain'='inventory' then
  insert into laras.inventory(owner_id,sku,name,variant,stock,minimum,source,source_row)
  select p_owner,r.sku,r.name,r.variant,r.stock,r.minimum,r.source,r.source_row
  from jsonb_to_recordset(p->'rows') as r(sku text,name text,variant text,stock integer,minimum integer,source text,source_row integer)
  on conflict(owner_id,sku) do update set name=excluded.name,variant=excluded.variant,stock=excluded.stock,minimum=excluded.minimum,source=excluded.source,source_row=excluded.source_row;
 elsif p->>'domain'='production' then
  insert into laras.production(owner_id,id,name,variant,qty,completed,stage,target,supplier,source)
  select p_owner,r.id,r.name,r.variant,r.qty,r.completed,r.stage,r.target,r.supplier,r.source
  from jsonb_to_recordset(p->'rows') as r(id text,name text,variant text,qty integer,completed integer,stage integer,target date,supplier text,source text)
  on conflict(owner_id,id) do update set name=excluded.name,variant=excluded.variant,qty=excluded.qty,completed=excluded.completed,stage=excluded.stage,target=excluded.target,supplier=excluded.supplier,source=excluded.source;
 else return laras.failure('INVALID_DOMAIN','Jenis data tidak valid.',422);end if;
 get diagnostics n=row_count;
 update laras.workspaces set revision=revision+1 where owner_id=p_owner returning revision into rev;
 insert into laras.audit_log(owner_id,action,metadata) values(p_owner,'catalog.updated',jsonb_build_object('domain',p->>'domain','rows',n,'revision',rev));
 return jsonb_build_object('rows',n,'revision',rev);
end$$;

create or replace function public.laras_rpc(p_owner text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog,laras as $$
declare result jsonb;c laras.chats;days integer;
begin
 if p_owner is null or length(p_owner) not between 1 and 200 then return laras.failure('AUTH_REQUIRED','Identitas diperlukan.',401);end if;
 insert into laras.workspaces(owner_id) values(p_owner) on conflict do nothing;
 days=coalesce((p_payload->>'days')::integer,21);
 if days not between 1 and 366 then return laras.failure('INVALID_PERIOD','Periode tidak valid.',422);end if;
 case p_action
 when 'bootstrap' then return laras.snapshot(p_owner,days);
 when 'dashboard' then return laras.analytics(p_owner,days);
 when 'preview' then return laras.preview_import(p_owner,p_payload);
 when 'commit' then return laras.commit_import(p_owner,p_payload);
 when 'rollback' then return laras.rollback_import(p_owner,p_payload);
 when 'catalog' then return laras.save_catalog(p_owner,p_payload);
 when 'preferences' then
  update laras.workspaces set name=coalesce(p_payload->>'name',name),preferences=preferences||coalesce(p_payload->'preferences','{}') where owner_id=p_owner;
  return jsonb_build_object('saved',true);
 when 'review' then
  if (p_payload->>'reviewed')::boolean then insert into laras.reviews(owner_id,fingerprint) values(p_owner,p_payload->>'fingerprint') on conflict do nothing;
  else delete from laras.reviews where owner_id=p_owner and fingerprint=p_payload->>'fingerprint';end if;
  return jsonb_build_object('saved',true);
 when 'chat_start' then
  perform 1 from laras.workspaces where owner_id=p_owner for update;
  select * into c from laras.chats where owner_id=p_owner and request_key=p_payload->>'requestKey';
  if found then
   if c.request_hash<>p_payload->>'hash' then return laras.failure('IDEMPOTENCY_CONFLICT','ID permintaan telah digunakan.');end if;
   if c.answer is null then return laras.failure('CHAT_IN_PROGRESS','Pertanyaan sedang diproses.');end if;
   return jsonb_build_object('id',c.id,'cached',c.answer);
  end if;
  if(select count(*) from laras.chats where owner_id=p_owner and created_at>now()-interval '1 minute')>=20 then return laras.failure('RATE_LIMIT','Maksimal 20 pertanyaan per menit.',429);end if;
  insert into laras.chats(owner_id,request_key,request_hash,question) values(p_owner,p_payload->>'requestKey',p_payload->>'hash',p_payload->>'question') returning * into c;
  return jsonb_build_object('id',c.id);
 when 'chat_finish' then
  update laras.chats set answer=p_payload->'answer' where owner_id=p_owner and id=(p_payload->>'id')::uuid and answer is null;
  return jsonb_build_object('saved',found);
 when 'history' then
  select coalesce(jsonb_agg(v order by v->>'created_at'),'[]') into result from(select jsonb_build_object('id',id,'question',question,'answer',answer,'created_at',created_at) as v from laras.chats where owner_id=p_owner and answer is not null order by created_at desc limit 50) x;
  return jsonb_build_object('messages',result);
 else return laras.failure('ACTION_NOT_FOUND','Operasi tidak tersedia.',404);
 end case;
end$$;

revoke all on function public.laras_rpc(text,text,jsonb) from public;
do $$begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on schema laras from anon;revoke all on function public.laras_rpc(text,text,jsonb) from anon;end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on schema laras from authenticated;revoke all on function public.laras_rpc(text,text,jsonb) from authenticated;end if;
 if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.laras_rpc(text,text,jsonb) to service_role;end if;
end$$;
insert into laras.schema_versions(version) values(1) on conflict do nothing;
notify pgrst,'reload schema';
commit;
