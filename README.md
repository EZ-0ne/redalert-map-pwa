# Red Alert LED Map — PWA

Live dashboard and control panel for the Red Alert LED Map ESP32 system.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main app shell — all 6 tabs |
| `app.js` | All app logic (connection, live map, calibrator, scenes, settings, history, device) |
| `cities.js` | Pikud HaOref city database (~1400 zones with lat/lon) |
| `style.css` | Complete design system, dark/light theme |
| `manifest.json` | PWA install manifest |
| `sw.js` | Service worker — offline caching |
| `icon-192.png` / `icon-512.png` | App icons (add your own) |

## Deploy to Cloudflare Pages

### Step 1 — Push to GitHub
1. Create a new **public** GitHub repo named `redalert-map-pwa`
2. Push all files in this folder to the repo root:
   ```
   git init
   git add .
   git commit -m "Initial PWA"
   git remote add origin https://github.com/YOUR_USERNAME/redalert-map-pwa.git
   git push -u origin main
   ```

### Step 2 — Connect Cloudflare Pages
1. Log into [cloudflare.com](https://cloudflare.com) → **Pages** → **Create a project**
2. Click **Connect to Git** → select your GitHub account → select `redalert-map-pwa`
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `/` (root)
4. Click **Save and Deploy**

Your app will be live at `https://redalert-map.pages.dev` within 60 seconds.

### Step 3 — Install on your phone
1. Open `https://redalert-map.pages.dev` in Chrome (Android) or Safari (iOS)
2. Tap **Add to Home Screen** / **Install App**
3. Done — app icon appears on your home screen and works offline

## First Launch

1. Connect your phone to the same WiFi as your ESP32 (or to the ESP32's own AP: `RedAlertMap` / `redalert1`)
2. Open the app
3. The app auto-tries `redalertmap.local` then `192.168.4.1`
4. If neither works, tap the phone icon and enter the IP manually
5. Once connected it remembers the address forever

## API Endpoints (ESP32 A3.1)

All endpoints support CORS — the PWA talks to them directly:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Full device status JSON |
| `/scenes` | GET/POST | Scene/color config |
| `/save` | POST | Settings (action=wifi or settings) |
| `/solidcities` | GET/POST | Solid-stay city list |
| `/cities?q=` | GET | City autocomplete |
| `/uploadmap` | POST | Upload city map JSON |
| `/calibrate` | GET | LED test (mode=led/clear) |
| `/testall` | GET | Test all LEDs |
| `/log` | GET | Alert log |
| `/syslog` | GET | System log |
| `/ota` | POST | Firmware update |

## Updating the UI

Push any change to GitHub — Cloudflare redeploys automatically in ~60 seconds.
No firmware flash needed for UI changes.

## Firmware

Flash `RedAlertLEDMap_A3_1.ino` to your ESP32 DevKit V1.
Required libraries: FastLED 3.10+, ArduinoJson 7.x, ESP32 Arduino 3.x
