# Licensing and subscriptions

The desktop app is gated by a licence key. There are two kinds, and one field takes both —
the app tells them apart by shape, so nobody has to be asked which one they have.

| | Subscription key | Offline key |
|---|---|---|
| Looks like | `kQ3xR7tYuV2wZ4aB6cD8eF0gH1iJ3kL5mN7oP9qS` | `OSINT-eyJleGFtcGxlIjp0cnVlfQ.ZXhhbXBsZVNpZ25hdHVyZQ` |
| Comes from | the dashboard (`ready-saas`) | `scripts/make-license.mjs` |
| Checked by | the dashboard, over HTTPS | an Ed25519 signature, on this machine |
| Can be revoked | yes | no, not without shipping a build |
| Tier | whatever the plan says today | whatever it was signed with (default premium) |
| Needs network | on activation, then periodically | never |

Subscription keys are the ordinary path. Offline keys stay for air-gapped and enterprise
deployments, and every key issued before tiers existed keeps working as premium.

## Tiers

Three: **trial**, **basic**, **premium**. The dashboard has more plans than that
(`STARTER`, `ADVANCED`, `PREMIUM`, `ENTERPRISE`…) and will grow more, so the mapping lives
on the server, in `orders/entitlements.py`. A plan names its tier with `Plan.app_tier`, or
leaves it blank to derive one from `Plan.tier`. Either way, a new plan can be sold without
shipping a desktop build.

Tiers set the *defaults*. What a licence actually grants comes from the plan's own feature
flags, so a single feature can be enabled for a single plan from the Django admin:

| App entitlement | Dashboard flag |
|---|---|
| `osint` | `allow_plugin_access` |
| `chat` | `allow_chat_view` |
| `graphAutomation` | `allow_graph_automation` |
| `customModels` | `allow_custom_chat_config` |
| `localAgent` | `allow_local_agent` |

## Working without a connection

A subscription answer is cached beside the key in `license.json`. From there:

- **under ~20 hours old** — used as-is, no request. The ordinary launch costs one file read.
- **20 hours to 14 days** — the app asks on launch but does not need an answer. No
  connection means it keeps working, and the Licence page says *"Working offline"* with the
  days remaining.
- **over 14 days** — the app stops until the server can be reached once.

Two failures are deliberately not the same thing. *The server said no* (revoked, cancelled,
expired) ends access immediately. *We could not ask* (timeout, DNS, a 500, a captive portal)
never does, inside the grace window. Only a `401` counts as a refusal.

The trade-off worth knowing: a key revoked on the dashboard keeps working on a machine that
has not checked in yet, for up to the freshness window. Pressing **Check for changes** in
Settings › Licence forces a check.

## Running the dashboard locally

```bash
cd ~/Documents/ready-saas
docker compose -f docker-compose.local.yml up -d postgres redis django
```

Needs a `.env`; `.env-sample` is the template. Only those three services are required for
licensing — the report API, dark-web and aggregator services are not.

Then create the plans, and mint a key:

```bash
docker exec -i readysaas-django python manage.py seed_desktop_tiers
docker exec -i readysaas-django python manage.py seed_desktop_tiers \
    --user you@example.org --tier premium
```

The second prints a licence key. Point the app at the local dashboard and paste it in:

```bash
cd apps/tangent-electron
OSINT_LICENSE_SERVER=http://localhost:8000 npm run start
```

`OSINT_LICENSE_SERVER` is honoured **only outside a packaged build**. A shipped application
uses the compiled-in address and nothing else — an environment variable that could redirect
the check to a friendlier server would be a licence bypass needing no tools at all.

## Where the code is

**Desktop** (`apps/tangent-electron/src/`)

- `common/license.ts` — key formats, tiers, entitlements, the grace-period arithmetic.
  Shared by main and the renderer, so it imports neither `electron` nor `node:crypto`.
- `main/license.ts` — storage, the cache, and the IPC surface. Routes a key to one of the
  two checkers.
- `main/license-verify.ts` — Ed25519 signature checking, for offline keys.
- `main/license-subscription.ts` — the only code that talks to the dashboard, and the only
  place its JSON is read.
- `main/license-policy.ts` — the offline decisions, pure and dependency-free.
- `app/model/license.ts` — the renderer store. Presentation only; see the note in that file.

**Dashboard** (`ready-saas/`)

- `orders/entitlements.py` — the tier mapping and the one function that builds what the
  app receives.
- `orders/report_views.py` → `desktop_license` — `GET /api/desktop/license`.
- `orders/management/commands/seed_desktop_tiers.py` — plans, and test keys.

## The endpoint

`GET /api/desktop/license`, with `Authorization: Bearer <key>`.

A lapsed key answers **200 with `active: false` and a reason**, not an error — the app has
to tell *"your subscription ended on the 3rd"* apart from *"that key does not exist"*, and
only the first can be said from a row that still exists. Only an unknown key is a `401`.

```json
{ "ok": true,
  "license": {
    "schema": 1, "active": true, "reason": null,
    "tier": "premium", "plan": "PREMIUM", "plan_display_name": "Premium",
    "email": "analyst@example.org", "is_trial": false,
    "subscription_status": "active",
    "expires": "2026-10-07T23:59:59.999999+00:00",
    "subscription_end_date": "2026-10-07",
    "credits": 400,
    "features": { "allow_plugin_access": true, "allow_chat_view": true, "…": true } } }
```

`expires` is when access stops and is what the offline check measures against;
`subscription_end_date` is the plain date, and is what gets shown. They are separate
because the first is the end of the last day, and rendering that in a timezone ahead of
the server's shows the day after the one the user is billed to.

## Enforcement, honestly

The desktop check is a lock on the front door, not a safe. Anyone who can edit the
application bundle can remove it, which is true of every licence check in every Electron
app. What it buys is that a key cannot be *forged* — invented as plausible-looking text or
shared as a screenshot.

Renderer-side entitlements are presentation: they grey out and explain what a plan does not
include, rather than offering something that then fails. Anything that costs money is
enforced by the dashboard, which counts credits against the key on every request.
