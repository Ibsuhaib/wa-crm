-- Upgrade 003: admin-managed templates, no repeat messages, birthday at check-in.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run again.

create table if not exists templates (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  title         text not null,                     -- friendly name shown in the dashboard
  name          text not null,                     -- Meta template name, e.g. thank_you_visit
  lang          text not null default 'en',
  text          text not null,                     -- what the admin typed, with {name} {business} {link}
  body          text not null,                     -- what Meta stores, with {{1}} {{2}}
  params        jsonb not null default '[]',       -- ["{name}","{business}"], one per {{n}}
  category      text not null default 'UTILITY',   -- as decided by Meta
  status        text not null default 'PENDING',   -- PENDING | APPROVED | REJECTED | PAUSED | DELETED ...
  reason        text,                              -- why Meta rejected it
  meta_id       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, name, lang)
);
alter table templates enable row level security;
revoke all on templates from anon, authenticated;

alter table businesses
  add column if not exists wa_waba_id          text,                      -- WhatsApp account ID in Meta
  add column if not exists repeat_days         int not null default 30,   -- same message at most once per N days
  add column if not exists checkin_template_id uuid references templates(id) on delete set null;

alter table messages
  add column if not exists template_name text,
  add column if not exists preview       text;     -- the message as the customer saw it

create index if not exists messages_repeat_idx on messages (customer_id, template_name);

-- Reserve one message for a customer, unless they already got this template in the last p_days.
-- Returns the new message id, or null when it would be a repeat. The lock makes two quick
-- check-ins at the counter unable to both pass.
create or replace function claim_message(p_business uuid, p_customer uuid, p_template text, p_days int)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_business::text || p_template, 0));
  if exists (select 1 from messages m
             where m.customer_id = p_customer and m.template_name = p_template and m.status <> 'failed'
               and coalesce(m.sent_at, m.created_at) > now() - make_interval(days => p_days)) then
    return null;
  end if;
  insert into messages (business_id, customer_id, template_name, status)
  values (p_business, p_customer, p_template, 'sending') returning id into v_id;
  return v_id;
end $$;

-- Queue a bulk send. Skips other restaurants' customers, anyone unsubscribed or without consent,
-- and anyone who got this template in the last p_days. Returns how many were queued.
create or replace function queue_messages(p_business uuid, p_campaign uuid, p_customers uuid[], p_template text, p_days int)
returns int language plpgsql as $$
declare v_count int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_business::text || p_template, 0));
  insert into messages (business_id, campaign_id, customer_id, template_name)
  select p_business, p_campaign, c.id, p_template
  from customers c
  where c.id = any(p_customers) and c.business_id = p_business
    and c.opted_out_at is null and c.consent_at is not null
    and not exists (select 1 from messages m
                    where m.customer_id = c.id and m.template_name = p_template and m.status <> 'failed'
                      and coalesce(m.sent_at, m.created_at) > now() - make_interval(days => p_days));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Check-in with an optional birthday. The old 5-argument version stays until this deploy is live.
create or replace function record_visit(p_business uuid, p_phone text, p_name text, p_amount numeric, p_consent boolean, p_birthday date)
returns setof customers language sql as $$
  with c as (
    insert into customers (business_id, phone, name, birthday, visits, total_spent, last_visit_at, source, consent_at)
    values (p_business, p_phone, nullif(trim(p_name), ''), p_birthday, 1, coalesce(p_amount, 0), now(), 'checkin',
            case when p_consent then now() end)
    on conflict (business_id, phone) do update set
      visits        = customers.visits + 1,
      total_spent   = customers.total_spent + coalesce(p_amount, 0),
      last_visit_at = now(),
      name          = coalesce(customers.name, excluded.name),
      birthday      = coalesce(excluded.birthday, customers.birthday),
      consent_at    = coalesce(customers.consent_at, excluded.consent_at)
    returning *
  ), v as (
    insert into visits (business_id, customer_id, amount) select p_business, id, p_amount from c
  )
  select * from c;
$$;

-- Only the server (service role) may call these, never the public anon key.
revoke execute on function claim_message(uuid, uuid, text, int) from public, anon, authenticated;
revoke execute on function queue_messages(uuid, uuid, uuid[], text, int) from public, anon, authenticated;
revoke execute on function record_visit(uuid, text, text, numeric, boolean, date) from public, anon, authenticated;
grant  execute on function claim_message(uuid, uuid, text, int) to service_role;
grant  execute on function queue_messages(uuid, uuid, uuid[], text, int) to service_role;
grant  execute on function record_visit(uuid, text, text, numeric, boolean, date) to service_role;
