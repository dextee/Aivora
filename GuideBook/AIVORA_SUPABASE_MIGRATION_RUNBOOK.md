# AIVORA — Supabase migration & offline→online runbook (final)

Hosted project: **AIVORA** · ref `icwjixjlxvicuwicwyot` · org `solomo` · region `ap-northeast-1` · Postgres 17 · API `https://icwjixjlxvicuwicwyot.supabase.co`
Branch: `feat/composer-attachments` in `D:\AIVORA\MAIN-FIX`. Commits: `ff323ce` (migrations), `12743b9` (request-scoped code), `28a5f90` (lease close).

## Architecture (as implemented)
- **RLS enabled on all `odai_*` tables; anonymous access denied.** Role-based policies keyed on `auth.uid()` + `odai_workspace_member(tenant_id, user_id, role)`.
- **Request-scoped, RLS-enforced client.** Normal reads/writes use the signed-in user's Supabase access token via an AsyncLocalStorage context (`db.runWithToken`), so PostgREST runs as `authenticated` and Postgres enforces per-user/tenant policies.
- **Service-role reserved for admin ops only** (demo seeding / migrations). Read from a server-side secret `SUPABASE_SERVICE_ROLE_KEY`; never client-side.
- **Migrations run via `SUPABASE_DB_URL`** (private env) using the Supabase CLI: `supabase db push --db-url "$SUPABASE_DB_URL"`. The DB password never enters prompts, Git, or frontend code.
- **Uploads:** DB metadata in `odai_upload`; actual file bytes copied separately to the private **Supabase Storage** bucket `odai-uploads` (path `<tenant_id>/<upload_id>/<filename>`), with `storage.objects` RLS scoped to the tenant prefix.
- **Memory only in explicit offline mode** (`AIVORA_MEMORY_MODE=1`). When Supabase is configured but unreachable, errors are surfaced (thrown), not silently swallowed.

## Versioned migrations (repo `odai/migrations/`)
- `001_init.sql` — 21 base `odai_*` tables.
- `002_seed_catalog.sql` — demo catalog (service/migration role).
- `003_identity.sql` — `odai_workspace_member` + SECURITY INVOKER helpers (`odai_is_member/can_write/is_any_member/is_admin_any/is_admin_member`) keyed on `auth.uid()`; member self-read + admin-manage RLS; demo membership seed.
- `004_rls.sql` — ENABLE+FORCE RLS and role-based policies on the 20 tenant tables (member read; owner/admin write) + `odai_fx_rate`.
- `005_upload.sql` — `odai_upload` metadata + private `odai-uploads` bucket + `storage.objects` RLS.

Principals (seeded): owner `…a1`, member `…b1` (demo-uncle-coffee-wellness); other-tenant owner `…c1` (demo-other-tenant-42).

## Env contract (staging/production)
```
SUPABASE_URL=https://icwjixjlxvicuwicwyot.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable/anon key>        # normal requests (RLS-enforced)
SUPABASE_INSTANCE_ID=icwjixjlxvicuwicwyot
SUPABASE_SERVICE_ROLE_KEY=<service key>                # admin seed/migrate only (server secret)
SUPABASE_DB_URL=postgres://...                         # migration tooling only (private)
# AIVORA_MEMORY_MODE unset = Supabase mode; =1 = offline memory
```
The client requires URL + publishable/anon + instance id all present to enter Supabase mode.

## Verification status (reported separately)
- **LOCAL (offline, `AIVORA_MEMORY_MODE=1`)**: typecheck ✅ · build ✅ · guardrails preflight ✅ · integrity ✅ (6 sealed files) · full suite **186 tests, 185 pass, 1 fail** (the single failure is `tests/authz.test.mjs:131` — a sealed test that `chmod`s a seal to force "unreadable" and expects fail-closed; **Windows ignores POSIX mode bits**, pre-existing/environmental, not a regression). The request-scoped changes are env-gated and inert offline, so the offline path is byte-for-byte the verified demo.
- **Supabase-mode RLS verification**: NOT RUN — blocked locally (see below). Run `tools/supa_verify.sql` (member read=10, anon denied, cross-workspace denied, owner write persists, member write denied) once a target exists.
- **Hosted staging**: the production **gate**. Apply `003/004/005` + run `supa_verify.sql` against staging, confirm signed-in read/write, cross-workspace denial, private upload→Storage, and restart persistence, before any production cutover.

## Exact blocker for the local stack
`supabase start` (and `docker system df`) fail because **`C:\` has 0 GB free**. Docker Desktop's WSL2 VM data disk lives on C:, so containerd's content store is **read-only** → image extraction fails (`.../meta.db: read-only file system`, `commit failed: input/output error`; `docker ps` now returns 500).
**Fix (user-side):** free space on `C:\` (or relocate Docker Desktop's data-root / resize its VHDX), restart Docker Desktop, then re-run the local stack and `tools/supa_verify.sql`.

## Commands once a target is available
```
# local stack (after freeing disk): 
supabase start && supabase db reset            # applies odai/migrations (timestamped copies in the scratch project)
supabase db query --local --file tools/supa_verify.sql

# hosted staging migration (private env, password never printed):
supabase db push --db-url "$SUPABASE_DB_URL"
psql "$SUPABASE_DB_URL" -f tools/supa_verify.sql
```

## Honest caveats
- No real Supabase Auth login exists in AIVORA yet (the demo "role" is client-side). The policies + request-scoped client are the correct foundation; minting real `auth.uid()` tokens is a separate auth feature. RLS enforcement is verified via simulated JWT claims, not a live login.
- Durable **resume** is still the V33-slot stub (`objectives.mjs:252`); restart-safe resume via DB is ENGINEV2-TRIO EN-1 (pending). The `odai_run` persistence proof in `supa_verify.sql` exercises the data layer, not the app's resume logic.
- `/api/odai/catalog` still reads the in-memory store; the DB seed mirrors it for parity.
- Hosted `001`/`002` were applied earlier via the MCP (privileged); `003/004/005` are committed and pending application to staging. Nothing was pushed/deployed; `D:\AIVORA\MAIN` reference untouched; V43/ECOMMERCE untouched.
