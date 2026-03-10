# passkit-generator Project Progress

## Project Overview
Building a personal Apple Wallet gym membership pass for Bryan Contreras at Evolutions Fitness & Wellness Center.

## What's Been Done

### 1. passkit-generator Setup
- Installed pnpm, ran `pnpm install` and `pnpm build`
- Downloaded Apple WWDR cert → `certificates/WWDR.pem`
- Extracted signer cert + key from `~/Downloads/Certificates.p12`
- Pass Type ID: `pass.bvyan.com` | Team ID: `C2G8UXXA46`

### 2. Cloudflare Worker (`examples/cloudflare-worker/`)
- Generates a `storeCard` Apple Wallet pass
- Background: `#074764` (dark blue)
- Logo: Evolutions logo resized to 160px wide, preserving aspect ratio
- Pass fields:
  - Header: Membership # (top right)
  - Primary: Member name (large)
  - Secondary: Open/Closed label + today's hours (dynamically calculated, Chicago timezone)
  - Back: gym name, member ID, member since date
  - Barcode: Code128, encodes membership number
- Gym hours:
  - Mon–Thu: 4:30am–10:00pm
  - Fri: 4:30am–8:00pm
  - Sat–Sun: 6:00am–6:00pm
- Accepts GET (defaults to Bryan's info) or POST with `{ name, id, memberSince }`
- Protected by token via `?token=` query param (stored as Cloudflare secret)
- Deployed at: `https://pg-cw-example.bryan-contreras83.workers.dev?token=@bryan534`

### 3. React Frontend (`examples/pass-portal/`)
- React + Vite scaffolded via `create cloudflare`
- Dev server: `cd examples/pass-portal && pnpm run dev` → http://localhost:5173
- CSS written — dark athletic theme, Barlow Condensed + Outfit fonts

## What's Next
- Write `App.tsx` — form with name, membership #, member since (optional) → POSTs to worker → downloads `.pkpass`
- Deploy frontend to Cloudflare Pages

## Key Files
| File | Purpose |
|------|---------|
| `examples/cloudflare-worker/src/index.ts` | Worker — generates the pass |
| `examples/cloudflare-worker/wrangler.toml` | Worker config + certs |
| `examples/models/gymMembership.pass/` | Pass image assets |
| `examples/pass-portal/src/` | React frontend |
