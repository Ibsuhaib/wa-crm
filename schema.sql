-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- RLS is enabled with no policies, so only the server (service role key) can read/write.

create extension if not exists pgcrypto;

create table businesses (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  wa_phone_number_id text,            -- from Meta: WhatsApp > API Setup
  wa_token           text,            -- permanent System User token (never sent to the browser)
  google_review_url  text,            -- https://g.page/r/.../review
  review_template    text,            -- approved template name used after a visit
  review_lang        text not null default 'en',
  review_params      jsonb not null default '["{name}","{business}","{link}"]',
  daily_limit        int  not null default 250,  -- Meta cap for unverified numbers
  created_at         timestamptz not null default now()
);

create table customers (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  phone         text not null,        -- digits with country code, e.g. 919876543210
  name          text,
  tags          text[] not null default '{}',
  birthday      date,
  visits        int not null default 0,
  last_visit_at timestamptz,
  opted_out_at  timestamptz,          -- set when the customer replies STOP
  created_at    timestamptz not null default now(),
  unique (business_id, phone)
);
create index on customers (business_id, last_visit_at);

create table visits (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  amount      numeric,
  created_at  timestamptz not null default now()
);

create table campaigns (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  name             text not null,
  kind             text not null check (kind in ('message', 'offer')),
  template_name    text not null,
  template_lang    text not null default 'en',
  params           jsonb not null default '[]',   -- e.g. ["{name}","{percent}","{code}"]
  tag              text,                          -- only customers with this tag (null = everyone)
  offer_percent    int,
  offer_valid_days int,
  status           text not null default 'ready' check (status in ('ready', 'done')),
  created_at       timestamptz not null default now()
);

create table messages (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  campaign_id   uuid references campaigns(id) on delete cascade,  -- null for review requests
  customer_id   uuid not null references customers(id) on delete cascade,
  status        text not null default 'queued'
                check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  wa_message_id text unique,
  error         text,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index on messages (campaign_id, status);
create index on messages (business_id, sent_at);

create table coupons (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  code        text not null,
  percent     int not null,
  expires_at  timestamptz not null,
  redeemed_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (business_id, code)
);
create index on coupons (campaign_id, customer_id);

create table reviews (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  token       text not null unique,
  rating      int check (rating between 1 and 5),
  feedback    text,
  rated_at    timestamptz,
  created_at  timestamptz not null default now()
);

create view campaign_stats with (security_invoker = true) as
select c.id, c.business_id, c.name, c.kind, c.status, c.offer_percent, c.created_at,
       count(m.id)                                           as total,
       count(m.id) filter (where m.status = 'queued')        as queued,
       count(m.id) filter (where m.status in ('sent', 'delivered', 'read')) as sent,
       count(m.id) filter (where m.status in ('delivered', 'read'))         as delivered,
       count(m.id) filter (where m.status = 'read')          as read,
       count(m.id) filter (where m.status = 'failed')        as failed,
       (select count(*) from coupons k where k.campaign_id = c.id and k.redeemed_at is not null) as redeemed
from campaigns c
left join messages m on m.campaign_id = c.id
group by c.id;

alter table businesses enable row level security;
alter table customers  enable row level security;
alter table visits     enable row level security;
alter table campaigns  enable row level security;
alter table messages   enable row level security;
alter table coupons    enable row level security;
alter table reviews    enable row level security;
