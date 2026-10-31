-- Upgrade 002: owner logins, loyalty, birthdays, QR join, segments, stats.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run again.

alter table businesses
  add column if not exists slug                text unique,      -- owner login ID, e.g. "cafe-mocha"
  add column if not exists owner_password_hash text,
  add column if not exists session_version     int  not null default 1,  -- bump to log out every device
  add column if not exists failed_logins       int  not null default 0,
  add column if not exists locked_until        timestamptz,
  add column if not exists active              boolean not null default true,
  add column if not exists wa_number           text,             -- shop's WhatsApp number, for the QR join link
  add column if not exists welcome_message     text default 'Thanks for joining {business}! You''ll get our offers here. Reply STOP anytime to unsubscribe.',
  add column if not exists loyalty_every       int,              -- e.g. 5 = every 5th visit earns a reward
  add column if not exists loyalty_reward      text,             -- e.g. "Free dessert"
  add column if not exists birthday_template   text,
  add column if not exists birthday_lang       text not null default 'en',
  add column if not exists birthday_params     jsonb not null default '["{name}","{business}","{percent}","{code}","{expiry}"]',
  add column if not exists birthday_percent    int  not null default 10;

alter table customers
  add column if not exists total_spent numeric not null default 0,
  add column if not exists source      text not null default 'manual',  -- manual | import | checkin | qr
  add column if not exists consent_at  timestamptz;                     -- when they agreed to WhatsApp messages
update customers set consent_at = created_at where consent_at is null;

alter table campaigns
  add column if not exists segment       text not null default 'all',  -- all | tag | inactive | regulars | new
  add column if not exists segment_value int;

alter table coupons
  add column if not exists reason text not null default 'campaign';    -- campaign | birthday

create index if not exists customers_birthday_idx on customers (business_id) where birthday is not null;
create index if not exists visits_biz_time_idx on visits (business_id, created_at);
create index if not exists reviews_biz_idx on reviews (business_id, rated_at);
create index if not exists coupons_customer_idx on coupons (customer_id);

-- Atomic check-in: creates or updates the customer and records the visit in one statement,
-- so two quick taps at the counter can never lose a visit.
create or replace function record_visit(p_business uuid, p_phone text, p_name text, p_amount numeric, p_consent boolean)
returns setof customers language sql as $$
  with c as (
    insert into customers (business_id, phone, name, visits, total_spent, last_visit_at, source, consent_at)
    values (p_business, p_phone, nullif(trim(p_name), ''), 1, coalesce(p_amount, 0), now(), 'checkin',
            case when p_consent then now() end)
    on conflict (business_id, phone) do update set
      visits        = customers.visits + 1,
      total_spent   = customers.total_spent + coalesce(p_amount, 0),
      last_visit_at = now(),
      name          = coalesce(customers.name, excluded.name),
      consent_at    = coalesce(customers.consent_at, excluded.consent_at)
    returning *
  ), v as (
    insert into visits (business_id, customer_id, amount) select p_business, id, p_amount from c
  )
  select * from c;
$$;

create or replace function business_stats(p_business uuid)
returns json language sql stable as $$
  select json_build_object(
    'customers',      (select count(*) from customers where business_id = p_business),
    'reachable',      (select count(*) from customers where business_id = p_business and opted_out_at is null and consent_at is not null),
    'opted_out',      (select count(*) from customers where business_id = p_business and opted_out_at is not null),
    'new_30d',        (select count(*) from customers where business_id = p_business and created_at > now() - interval '30 days'),
    'repeat',         (select count(*) from customers where business_id = p_business and visits >= 2),
    'visited',        (select count(*) from customers where business_id = p_business and visits >= 1),
    'visits_30d',     (select count(*) from visits where business_id = p_business and created_at > now() - interval '30 days'),
    'revenue_30d',    (select coalesce(sum(amount), 0) from visits where business_id = p_business and created_at > now() - interval '30 days'),
    'avg_rating',     (select round(avg(rating)::numeric, 1) from reviews where business_id = p_business and rating is not null),
    'ratings',        (select count(*) from reviews where business_id = p_business and rating is not null),
    'review_requests',(select count(*) from reviews where business_id = p_business),
    'complaints_30d', (select count(*) from reviews where business_id = p_business and rating <= 3 and rated_at > now() - interval '30 days'),
    'coupons_issued_30d',   (select count(*) from coupons where business_id = p_business and created_at > now() - interval '30 days'),
    'coupons_redeemed_30d', (select count(*) from coupons where business_id = p_business and redeemed_at > now() - interval '30 days'),
    'messages_30d',   (select count(*) from messages where business_id = p_business and sent_at > now() - interval '30 days'),
    'visits_by_day',  (select coalesce(json_agg(json_build_object('day', d, 'visits', n) order by d), '[]')
                       from (select gs::date as d,
                                    (select count(*) from visits v where v.business_id = p_business
                                       and (v.created_at at time zone 'Asia/Kolkata')::date = gs::date) as n
                             from generate_series((now() at time zone 'Asia/Kolkata')::date - 13,
                                                  (now() at time zone 'Asia/Kolkata')::date, interval '1 day') gs) t)
  );
$$;

-- Customers whose birthday is today and who haven't had a birthday coupon in the last ~10 months.
create or replace function birthdays_today(p_month int, p_day int)
returns table (customer_id uuid, business_id uuid, phone text, name text) language sql stable as $$
  select c.id, c.business_id, c.phone, c.name
  from customers c join businesses b on b.id = c.business_id
  where b.active and b.birthday_template is not null
    and c.opted_out_at is null and c.consent_at is not null and c.birthday is not null
    and extract(month from c.birthday) = p_month and extract(day from c.birthday) = p_day
    and not exists (select 1 from coupons k where k.customer_id = c.id and k.reason = 'birthday'
                    and k.created_at > now() - interval '300 days');
$$;

-- Only the server (service role) may call these, never the public anon key.
revoke execute on function record_visit(uuid, text, text, numeric, boolean) from public, anon, authenticated;
revoke execute on function business_stats(uuid) from public, anon, authenticated;
revoke execute on function birthdays_today(int, int) from public, anon, authenticated;
grant  execute on function record_visit(uuid, text, text, numeric, boolean) to service_role;
grant  execute on function business_stats(uuid) to service_role;
grant  execute on function birthdays_today(int, int) to service_role;

-- campaign_stats is a view; make sure the public roles can't read it either.
revoke all on campaign_stats from anon, authenticated;
