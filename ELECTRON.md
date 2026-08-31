# OpenHive — Electron Desktop App

OpenHive ek **Next.js server app** hai (API routes + middleware + Supabase runtime secrets). Is liye Electron mein sirf static files (`file://`) load karna mumkin nahin — is ke bajaye Electron shell ek **asli Next.js server** start karta hai aur usay apni window mein render karta hai.

```
┌─────────────────────┐      spawn       ┌──────────────────────┐
│  Electron main      │ ───────────────► │  Next.js server      │
│  (electron/main.js) │  free port pe    │  (dev / standalone)  │
│                     │ ◄─────────────── │                      │
│  BrowserWindow      │   HTTP ready     │  API routes, SSR,    │
│  (OpenHive UI)      │  load URL        │  middleware, secrets │
└─────────────────────┘                  └──────────────────────┘
```

## Setup (sirf ek dafa)

```bash
npm install
```

## 1) Development mode (hot reload ke saath)

```bash
npm run electron:dev
```

Kya hota hai:
- Koi **free port** dhoondta hai (taake aapka normal `npm run dev` (port 3000) se takkar na ho)
- `next dev` us port pe start karta hai aur ready hone ka wait karta hai
- Electron window OpenHive render karti hai — **hot reload chalta rehta hai**

## 2) Production preview (build ke baad local test)

```bash
npm run electron:preview
```

- `next build` chalta hai (`output: "standalone"` ke saath)
- `.next/standalone/server.js` run hota hai — bilkul waisa hi jaisa packaged app chalega

## 3) Windows installer banana

```bash
npm run electron:build
```

- Installer yahan banta hai: **`dist-electron/OpenHive Setup <version>.exe`**
- electron-builder standalone server ko `resources/server` mein bundle karta hai; installed app apna server khud start karta hai

## Environment variables (important!)

Do tarah ki keys hain:

| Qism | Keys | Kab load hoti hain | Update kaise |
|---|---|---|---|
| **Build-time** (JS bundle mein bake ho jati hain) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PERSONAL_KEY` | `next build` ke waqt, `.env.local` se | `.env.local` badlein → **dobara build/install karna zaroori** |
| **Runtime** (API routes har request pe parhti hain) | `SUPABASE_SERVICE_ROLE_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | App chalne ke waqt | `%APPDATA%\OpenHive\.env.local` badlein → **sirf app restart** (rebuild nahi chahiye) |

Installed app in jagahon se keys uthati hai (aakhri wali sab se strong):

1. Project `.env.local` (dev/preview)
2. `resources/server/.env.local` (agar khud rakhi ho)
3. **`%APPDATA%\OpenHive\.env.local`** ← installed app ke liye yehi main jagah hai
4. Windows environment variables (`setx`) — file values par bhaari

Setup wizard (`/api/setup`) sirf dev mode mein kaam karta hai — installed app ke liye upar wali file khud banayen/maintain karein.

## Advanced: already-running server se attach

Agar aap server khud chalana chahte hain:

```powershell
# Terminal 1
npm run dev

# Terminal 2
$env:OPENHIVE_URL = "http://localhost:3000"; npx electron .
```

## Masail aur hal (Troubleshooting)

- **"The Next.js server exited unexpectedly (code 1)" app khulte hi** — purani build ka masla tha: electron-builder extraResources copy karte waqt standalone server ki `node_modules` skip kar deta tha, is liye installed app (`C:\Program Files\OpenHive`) mein `require("next")` fail ho jata tha. **Hal:** `package.json` mein ab node_modules ki alag extraResources entry hai — dobara `npm run electron:build` chala kar naya installer run karein (version purana ho to bhi woh upgrade kar dega)
- **Server ki details dekhni hon** — har run ki output `%APPDATA%\OpenHive\next-server.log` mein likhi jati hai; error dialog mein bhi aakhri lines show hoti hain
- **Pehli dafa window khulne mein time lagta hai** — normal hai, `next dev` / standalone server start hone ka wait kiya jata hai (max 120s)
- **"Standalone build not found"** — pehle `npm run build` chalayein (ya seedha `npm run electron:preview` use karein)
- **Window band karte hi server band ho jata hai** — yehi intended behavior hai (`taskkill /T` se poora process tree saaf hota hai)
- **Mic/camera calls (LiveKit)** — Electron permission handler app-origin ke liye allow karta hai, kuch extra config ki zaroorat nahin

## Kya-kya add hua

- `electron/main.js` — main process (server spawn, window, permissions, cleanup)
- `next.config.ts` — `output: "standalone"`
- `package.json` — `main`, `electron:*` scripts, electron-builder `build` config
- `.gitignore` — `dist-electron/`
