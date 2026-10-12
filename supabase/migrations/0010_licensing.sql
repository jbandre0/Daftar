-- Phase 9: licensing. The webhook (Edge Function, service role) is the only thing that ever changes a licence.
-- The function below holds ALL the rules, so they are tested on real Postgres and the Edge Function stays thin.
--
-- apply_license_event(provider, kind, order_id, user_id)
--   kind 'paid'     : unlock. Same order again = no-op. A second, different order while unlocked keeps the first
--                     (returned as 'already_unlocked' so the owner can refund the extra one by hand).
--                     After a refund, a new purchase unlocks again. An order that was refunded before its 'paid'
--                     event arrived (webhooks can arrive out of order) is never unlocked.
--   kind 'refunded' : looked up by ORDER, not by user. Only the licence that order unlocked goes read-only;
--                     a refund of an older order never touches a newer unlock. No data is touched.
-- Every event is recorded once in license_events (provider, order, kind), which is also what makes a replay a no-op.
-- Returns: unlocked | refunded | duplicate | already_unlocked | refunded_before_paid | unknown_user | unknown_order | ignored

create table license_events (
  id         bigint generated always as identity primary key,
  provider   text not null,
  order_id   text not null,
  kind       text not null check (kind in ('paid', 'refunded')),
  user_id    uuid,
  outcome    text not null,
  created_at timestamptz not null default now(),
  unique (provider, order_id, kind)
);
alter table license_events enable row level security; -- no policies, no grants: clients never see this

create function apply_license_event(p_provider text, p_kind text, p_order_id text, p_user_id uuid default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_lic licenses%rowtype;
  v_outcome text;
  v_event bigint;
begin
  if p_kind not in ('paid', 'refunded') or coalesce(p_provider, '') = '' or coalesce(p_order_id, '') = '' then
    return 'ignored';
  end if;

  -- one event per (provider, order, kind): a replay stops here
  insert into license_events (provider, order_id, kind, user_id, outcome)
  values (p_provider, p_order_id, p_kind, p_user_id, 'pending')
  on conflict (provider, order_id, kind) do nothing
  returning id into v_event;
  if v_event is null then return 'duplicate'; end if;

  if p_kind = 'paid' then
    if p_user_id is null or not exists (select 1 from licenses where user_id = p_user_id) then
      v_outcome := 'unknown_user';
    elsif exists (select 1 from license_events where provider = p_provider and order_id = p_order_id and kind = 'refunded') then
      v_outcome := 'refunded_before_paid';
    else
      select * into v_lic from licenses where user_id = p_user_id for update;
      if v_lic.status = 'unlocked' then
        v_outcome := 'already_unlocked';
      else
        update licenses
           set status = 'unlocked', unlocked_at = now(), provider = p_provider, provider_order_id = p_order_id
         where user_id = p_user_id;
        v_outcome := 'unlocked';
      end if;
    end if;
  else
    select * into v_lic from licenses
     where provider = p_provider and provider_order_id = p_order_id for update;
    if not found then
      v_outcome := 'unknown_order';
    elsif v_lic.status = 'refunded' then
      v_outcome := 'duplicate';
    else
      update licenses set status = 'refunded' where user_id = v_lic.user_id;
      v_outcome := 'refunded';
    end if;
  end if;

  update license_events set outcome = v_outcome where id = v_event;
  return v_outcome;
end;
$$;

revoke all on function apply_license_event(text, text, text, uuid) from public, anon, authenticated;
grant execute on function apply_license_event(text, text, text, uuid) to service_role;
grant select, insert, update on license_events to service_role;
grant select, update on licenses to service_role;
