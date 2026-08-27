# AINO Cloudflare edge router

Same-origin router for the split Railway services and public SPA bucket.

## Correct routing contract

| Public path | Origin |
|---|---|
| `/api`, `/api/*` | Railway `aino-web` |
| `/uploads`, `/uploads/*` | Railway `aino-web` — authorization then private R2 presign |
| `/ws` | Railway `aino-realtime` (WebSocket pass-through) |
| `/collab`, `/collab/*` | Railway `aino-realtime` (WebSocket pass-through) |
| everything else | public SPA R2 custom domain |

`/uploads` must **never** point directly to public R2. `aino-uploads` is private,
and the web service enforces tenant/org/chat authorization before issuing a
60-second signed URL.

## Required Worker variables

| Variable | Example |
|---|---|
| `ROUTING_MODE` | `legacy` or `split` |
| `LEGACY_ORIGIN` | `https://<current-role-all>.up.railway.app` |
| `WEB_ORIGIN` | `https://<aino-web>.up.railway.app` |
| `REALTIME_ORIGIN` | `https://<aino-realtime>.up.railway.app` |
| `SPA_ORIGIN` | `https://<public-spa-bucket-domain>` |
| `ORIGIN_SECRET` | random value forwarded as `X-AINO-Origin-Secret` |

Origins must be separate hostnames and must not equal the public Worker host,
otherwise requests recurse through the Worker.

## Safe rollout

1. Deploy the Worker with `ROUTING_MODE=legacy`; all traffic remains on the
   existing `ROLE=all` service. This is the instant rollback mode.
2. Publish SPA assets with `.github/workflows/web-release.yml`.
3. Validate web/realtime/worker Railway services via their direct domains.
4. Switch a staging hostname to `ROUTING_MODE=split`.
5. Verify cookies, CSRF, uploads, `/ws`, `/collab`, SPA navigation and service
   worker updates.
6. Switch production to `split`; retain the prior Worker version and `ROLE=all`
   for one rollback window.

## Origin protection

The Worker adds `X-AINO-Origin-Secret`. During migration, direct Railway origins
remain reachable for legacy desktop/mobile builds. Measure that traffic before
enforcing the secret; otherwise old clients will be cut off. Add origin-secret
enforcement only after those clients have migrated.

## Commands

```bash
cd infra/cloudflare
npm install
npm test
npx wrangler secret put LEGACY_ORIGIN
npx wrangler secret put WEB_ORIGIN
npx wrangler secret put REALTIME_ORIGIN
npx wrangler secret put SPA_ORIGIN
npx wrangler secret put ORIGIN_SECRET
npx wrangler deploy
```