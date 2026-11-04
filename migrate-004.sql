-- Upgrade 004: Birthdays screen, automatic wishes, named birthday templates.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run again.

alter table templates
  add column if not exists purpose text not null default 'visit';   -- visit | birthday

alter table businesses
  add column if not exists birthday_access      boolean not null default false,  -- admin lets this restaurant use Birthdays
  add column if not exists birthday_auto        boolean not null default false,  -- the restaurant's on/off switch
  add column if not exists birthday_template_id uuid references templates(id) on delete set null;

alter table messages
  add column if not exists kind text;                               -- 'birthday' for wishes

create index if not exists messages_birthday_idx on messages (customer_id) where kind = 'birthday';

-- Everyone to wish today (India date). Feb 29 birthdays are wished on Feb 28 in other years.
create or replace function birthdays_due()
returns table (customer_id uuid, business_id uuid, phone text, name text) language sql stable as $$
  with t as (select (now() at time zone 'Asia/Kolkata')::date as d)
  select c.id, c.business_id, c.phone, c.name
  from customers c join businesses b on b.id = c.business_id, t
  where b.active and b.birthday_access and b.birthday_auto and b.birthday_template_id is not null
    and c.opted_out_at is null and c.consent_at is not null and c.birthday is not null
    and (to_char(c.birthday, 'MM-DD') = to_char(t.d, 'MM-DD')
         or (to_char(c.birthday, 'MM-DD') = '02-29' and to_char(t.d, 'MM-DD') = '02-28' and to_char(t.d + 1, 'MM-DD') = '03-01'))
    and not exists (select 1 from messages m where m.customer_id = c.id and m.kind = 'birthday' and m.status <> 'failed'
                    and m.created_at > now() - interval '300 days');
$$;

-- Reserve this year's wish. Returns the message id, or null if the customer was already wished.
create or replace function claim_birthday(p_business uuid, p_customer uuid, p_template text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_customer::text || 'birthday', 0));
  if exists (select 1 from messages m where m.customer_id = p_customer and m.kind = 'birthday' and m.status <> 'failed'
             and m.created_at > now() - interval '300 days') then
    return null;
  end if;
  insert into messages (business_id, customer_id, template_name, kind, status)
  values (p_business, p_customer, p_template, 'birthday', 'sending') returning id into v_id;
  return v_id;
end $$;

-- Birthdays coming up for one restaurant, soonest first.
create or replace function birthdays_upcoming(p_business uuid, p_days int)
returns table (id uuid, name text, phone text, birthday date, days_away int, reachable boolean, wished boolean)
language sql stable as $$
  select c.id, c.name, c.phone, c.birthday, d.n,
         c.opted_out_at is null and c.consent_at is not null,
         exists (select 1 from messages m where m.customer_id = c.id and m.kind = 'birthday' and m.status <> 'failed'
                 and m.created_at > now() - interval '300 days')
  from customers c
  join generate_series(0, p_days - 1) d(n)
    on to_char(c.birthday, 'MM-DD') = to_char((now() at time zone 'Asia/Kolkata')::date + d.n, 'MM-DD')
  where c.business_id = p_business and c.birthday is not null
  order by d.n, c.name
  limit 200;
$$;

drop function if exists birthdays_today(int, int);

-- Only the server (service role) may call these, never the public anon key.
revoke execute on function birthdays_due() from public, anon, authenticated;
revoke execute on function claim_birthday(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function birthdays_upcoming(uuid, int) from public, anon, authenticated;
grant  execute on function birthdays_due() to service_role;
grant  execute on function claim_birthday(uuid, uuid, text) to service_role;
grant  execute on function birthdays_upcoming(uuid, int) to service_role;
