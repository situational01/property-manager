-- Property Manager - final cloud schema
-- Run this entire file in Supabase SQL Editor.
-- It is safe to run more than once on a fresh or existing Property Manager project.

create extension if not exists pgcrypto;

create table if not exists public.property_manager_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My Property',
  due_day integer not null default 5 check (due_day between 1 and 28),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pm_workspace_owner_uidx on public.property_manager_workspaces(owner_id);

create table if not exists public.property_manager_workspace_members (
  workspace_id uuid not null references public.property_manager_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','manager','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.property_manager_houses (
  id text primary key,
  workspace_id uuid not null references public.property_manager_workspaces(id) on delete cascade,
  number text not null,
  type text not null default '',
  rent numeric(14,2) not null default 0 check (rent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pm_houses_workspace_number_uidx on public.property_manager_houses(workspace_id, lower(number));
create index if not exists pm_houses_workspace_idx on public.property_manager_houses(workspace_id);

create table if not exists public.property_manager_tenants (
  id text primary key,
  workspace_id uuid not null references public.property_manager_workspaces(id) on delete cascade,
  name text not null,
  phone text not null default '',
  house_id text not null references public.property_manager_houses(id) on delete restrict,
  rent numeric(14,2) not null default 0 check (rent >= 0),
  move_in_date date not null,
  status text not null default 'active' check (status in ('active','moved_out')),
  move_out_date date,
  statement_ref text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pm_tenants_workspace_idx on public.property_manager_tenants(workspace_id);
create index if not exists pm_tenants_house_idx on public.property_manager_tenants(workspace_id,house_id);
create unique index if not exists pm_tenants_statement_uidx on public.property_manager_tenants(workspace_id,statement_ref);
-- Partial uniqueness: one active tenant per house.
create unique index if not exists pm_active_house_uidx on public.property_manager_tenants(workspace_id,house_id) where status='active';

create table if not exists public.property_manager_payments (
  id text primary key,
  workspace_id uuid not null references public.property_manager_workspaces(id) on delete cascade,
  tenant_id text not null references public.property_manager_tenants(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  payment_date date not null,
  rent_month text not null check (rent_month ~ '^[0-9]{4}-[0-9]{2}$'),
  method text not null default 'M-Pesa',
  reference text not null default '',
  receipt_no text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pm_payments_workspace_idx on public.property_manager_payments(workspace_id);
create index if not exists pm_payments_tenant_idx on public.property_manager_payments(workspace_id,tenant_id);
create index if not exists pm_payments_month_idx on public.property_manager_payments(workspace_id,rent_month);
create unique index if not exists pm_receipt_uidx on public.property_manager_payments(workspace_id,receipt_no);

-- Helper: current user is owner or member of a workspace.
create or replace function public.pm_is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.property_manager_workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
  )
  or exists (
    select 1
    from public.property_manager_workspaces w
    where w.id = p_workspace_id
      and w.owner_id = auth.uid()
  );
$$;

revoke all on function public.pm_is_workspace_member(uuid) from public;
grant execute on function public.pm_is_workspace_member(uuid) to authenticated;

-- Automatically add each workspace owner as an owner-member.
create or replace function public.pm_add_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.property_manager_workspace_members(workspace_id,user_id,role)
  values (new.id,new.owner_id,'owner')
  on conflict (workspace_id,user_id) do update set role='owner';
  return new;
end;
$$;

drop trigger if exists pm_workspace_owner_trigger on public.property_manager_workspaces;
create trigger pm_workspace_owner_trigger
after insert on public.property_manager_workspaces
for each row execute function public.pm_add_workspace_owner();

-- Update timestamps automatically.
create or replace function public.pm_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pm_workspaces_touch on public.property_manager_workspaces;
create trigger pm_workspaces_touch before update on public.property_manager_workspaces for each row execute function public.pm_touch_updated_at();
drop trigger if exists pm_houses_touch on public.property_manager_houses;
create trigger pm_houses_touch before update on public.property_manager_houses for each row execute function public.pm_touch_updated_at();
drop trigger if exists pm_tenants_touch on public.property_manager_tenants;
create trigger pm_tenants_touch before update on public.property_manager_tenants for each row execute function public.pm_touch_updated_at();
drop trigger if exists pm_payments_touch on public.property_manager_payments;
create trigger pm_payments_touch before update on public.property_manager_payments for each row execute function public.pm_touch_updated_at();

-- Enforce tenant/workspace consistency.
create or replace function public.pm_check_tenant_house_workspace()
returns trigger
language plpgsql
as $$
declare house_workspace uuid;
begin
  select workspace_id into house_workspace from public.property_manager_houses where id = new.house_id;
  if house_workspace is null or house_workspace <> new.workspace_id then
    raise exception 'Tenant house must belong to the same workspace';
  end if;
  return new;
end;
$$;
drop trigger if exists pm_tenant_house_workspace on public.property_manager_tenants;
create trigger pm_tenant_house_workspace before insert or update on public.property_manager_tenants for each row execute function public.pm_check_tenant_house_workspace();

create or replace function public.pm_check_payment_tenant_workspace()
returns trigger
language plpgsql
as $$
declare tenant_workspace uuid;
begin
  select workspace_id into tenant_workspace from public.property_manager_tenants where id = new.tenant_id;
  if tenant_workspace is null or tenant_workspace <> new.workspace_id then
    raise exception 'Payment tenant must belong to the same workspace';
  end if;
  return new;
end;
$$;
drop trigger if exists pm_payment_tenant_workspace on public.property_manager_payments;
create trigger pm_payment_tenant_workspace before insert or update on public.property_manager_payments for each row execute function public.pm_check_payment_tenant_workspace();

-- Row Level Security
alter table public.property_manager_workspaces enable row level security;
alter table public.property_manager_workspace_members enable row level security;
alter table public.property_manager_houses enable row level security;
alter table public.property_manager_tenants enable row level security;
alter table public.property_manager_payments enable row level security;

-- Workspaces
 drop policy if exists pm_workspace_select on public.property_manager_workspaces;
 drop policy if exists pm_workspace_insert on public.property_manager_workspaces;
 drop policy if exists pm_workspace_update on public.property_manager_workspaces;
 drop policy if exists pm_workspace_delete on public.property_manager_workspaces;
create policy pm_workspace_select on public.property_manager_workspaces for select to authenticated using (owner_id=auth.uid() or public.pm_is_workspace_member(id));
create policy pm_workspace_insert on public.property_manager_workspaces for insert to authenticated with check (owner_id=auth.uid());
create policy pm_workspace_update on public.property_manager_workspaces for update to authenticated using (owner_id=auth.uid() or public.pm_is_workspace_member(id)) with check (owner_id=auth.uid() or public.pm_is_workspace_member(id));
create policy pm_workspace_delete on public.property_manager_workspaces for delete to authenticated using (owner_id=auth.uid());

-- Members
 drop policy if exists pm_member_select on public.property_manager_workspace_members;
 drop policy if exists pm_member_insert on public.property_manager_workspace_members;
 drop policy if exists pm_member_update on public.property_manager_workspace_members;
 drop policy if exists pm_member_delete on public.property_manager_workspace_members;
create policy pm_member_select on public.property_manager_workspace_members for select to authenticated using (public.pm_is_workspace_member(workspace_id));
create policy pm_member_insert on public.property_manager_workspace_members for insert to authenticated with check (exists(select 1 from public.property_manager_workspaces w where w.id=workspace_id and w.owner_id=auth.uid()));
create policy pm_member_update on public.property_manager_workspace_members for update to authenticated using (exists(select 1 from public.property_manager_workspaces w where w.id=workspace_id and w.owner_id=auth.uid()));
create policy pm_member_delete on public.property_manager_workspace_members for delete to authenticated using (exists(select 1 from public.property_manager_workspaces w where w.id=workspace_id and w.owner_id=auth.uid()));

-- Data tables
 drop policy if exists pm_houses_select on public.property_manager_houses;
 drop policy if exists pm_houses_insert on public.property_manager_houses;
 drop policy if exists pm_houses_update on public.property_manager_houses;
 drop policy if exists pm_houses_delete on public.property_manager_houses;
create policy pm_houses_select on public.property_manager_houses for select to authenticated using (public.pm_is_workspace_member(workspace_id));
create policy pm_houses_insert on public.property_manager_houses for insert to authenticated with check (public.pm_is_workspace_member(workspace_id));
create policy pm_houses_update on public.property_manager_houses for update to authenticated using (public.pm_is_workspace_member(workspace_id)) with check (public.pm_is_workspace_member(workspace_id));
create policy pm_houses_delete on public.property_manager_houses for delete to authenticated using (public.pm_is_workspace_member(workspace_id));

 drop policy if exists pm_tenants_select on public.property_manager_tenants;
 drop policy if exists pm_tenants_insert on public.property_manager_tenants;
 drop policy if exists pm_tenants_update on public.property_manager_tenants;
 drop policy if exists pm_tenants_delete on public.property_manager_tenants;
create policy pm_tenants_select on public.property_manager_tenants for select to authenticated using (public.pm_is_workspace_member(workspace_id));
create policy pm_tenants_insert on public.property_manager_tenants for insert to authenticated with check (public.pm_is_workspace_member(workspace_id));
create policy pm_tenants_update on public.property_manager_tenants for update to authenticated using (public.pm_is_workspace_member(workspace_id)) with check (public.pm_is_workspace_member(workspace_id));
create policy pm_tenants_delete on public.property_manager_tenants for delete to authenticated using (public.pm_is_workspace_member(workspace_id));

 drop policy if exists pm_payments_select on public.property_manager_payments;
 drop policy if exists pm_payments_insert on public.property_manager_payments;
 drop policy if exists pm_payments_update on public.property_manager_payments;
 drop policy if exists pm_payments_delete on public.property_manager_payments;
create policy pm_payments_select on public.property_manager_payments for select to authenticated using (public.pm_is_workspace_member(workspace_id));
create policy pm_payments_insert on public.property_manager_payments for insert to authenticated with check (public.pm_is_workspace_member(workspace_id));
create policy pm_payments_update on public.property_manager_payments for update to authenticated using (public.pm_is_workspace_member(workspace_id)) with check (public.pm_is_workspace_member(workspace_id));
create policy pm_payments_delete on public.property_manager_payments for delete to authenticated using (public.pm_is_workspace_member(workspace_id));

-- Ensure any existing workspaces have an owner-member row.
insert into public.property_manager_workspace_members(workspace_id,user_id,role)
select id,owner_id,'owner' from public.property_manager_workspaces
on conflict (workspace_id,user_id) do update set role='owner';

-- -------------------------------------------------------------------------
-- Optional migration from the earlier single-JSON workspace build.
-- If your existing property_manager_workspaces table still has a `state`
-- column, the block below copies the old houses, tenants and payments into
-- the new normalized tables without overwriting rows that already exist.
-- -------------------------------------------------------------------------
alter table public.property_manager_workspaces
  add column if not exists due_day integer not null default 5;

alter table public.property_manager_workspaces
  drop constraint if exists property_manager_workspaces_due_day_check;
alter table public.property_manager_workspaces
  add constraint property_manager_workspaces_due_day_check check (due_day between 1 and 28);

do $$
declare
  w record;
  item jsonb;
  new_due_day integer;
begin
  -- This migration is intentionally conditional so it is safe on a fresh schema.
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='property_manager_workspaces' and column_name='state'
  ) then
    for w in execute 'select id, owner_id, state from public.property_manager_workspaces where state is not null' loop
      new_due_day := coalesce((w.state->'settings'->>'dueDay')::integer, 5);
      update public.property_manager_workspaces set due_day = greatest(1, least(28, new_due_day)) where id=w.id;

      if jsonb_typeof(w.state->'houses') = 'array' then
        for item in select value from jsonb_array_elements(w.state->'houses') loop
          insert into public.property_manager_houses(id,workspace_id,number,type,rent)
          values (
            item->>'id', w.id, coalesce(item->>'number',''), coalesce(item->>'type',''), coalesce((item->>'rent')::numeric,0)
          ) on conflict (id) do nothing;
        end loop;
      end if;

      if jsonb_typeof(w.state->'tenants') = 'array' then
        for item in select value from jsonb_array_elements(w.state->'tenants') loop
          insert into public.property_manager_tenants(id,workspace_id,name,phone,house_id,rent,move_in_date,status,move_out_date,statement_ref)
          values (
            item->>'id',
            w.id,
            coalesce(item->>'name',''),
            coalesce(item->>'phone',''),
            item->>'houseId',
            coalesce((item->>'rent')::numeric,0),
            coalesce((item->>'moveInDate')::date, current_date),
            case when item->>'status'='moved_out' then 'moved_out' else 'active' end,
            nullif(item->>'moveOutDate','')::date,
            coalesce(nullif(item->>'statementRef',''), 'TEN-' || substr(item->>'id',1,8))
          ) on conflict (id) do nothing;
        end loop;
      end if;

      if jsonb_typeof(w.state->'payments') = 'array' then
        for item in select value from jsonb_array_elements(w.state->'payments') loop
          insert into public.property_manager_payments(id,workspace_id,tenant_id,amount,payment_date,rent_month,method,reference,receipt_no)
          values (
            item->>'id',
            w.id,
            item->>'tenantId',
            coalesce((item->>'amount')::numeric,0),
            coalesce((item->>'paymentDate')::date, current_date),
            coalesce(item->>'rentMonth', to_char(current_date,'YYYY-MM')),
            coalesce(nullif(item->>'method',''),'M-Pesa'),
            coalesce(item->>'reference',''),
            coalesce(nullif(item->>'receiptNo',''),'REC-' || extract(year from current_date)::text || '-' || substr(item->>'id',1,8))
          ) on conflict (id) do nothing;
        end loop;
      end if;
    end loop;
  end if;
end $$;
