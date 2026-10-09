# Deploy: Render + Firebase (Firestore) + Cloudinary

How it fits together
- **Render** runs the Node server (`render-server.js`) and serves the site and `/api`.
- **Firebase** is used for **Firestore only** (your database). No Cloud Functions, so the free Spark plan is enough.
- **Cloudinary** stores gallery photos, resource files and chat/profile images.
- Render's disk is temporary, so on every start the server reloads all data from Firestore and writes changes back after each edit.

Run exactly one instance (do not scale to 2+).

## 1. Firebase
1. console.firebase.google.com > open project `cuet-cse-25` (or create one) > Build > **Firestore Database** > Create (Native mode, e.g. `asia-south1`).
2. Project settings > Service accounts > **Generate new private key**. Keep that JSON file private.
3. (Optional) lock Firestore down: `firebase deploy --only firestore:rules`

## 2. Cloudinary
Dashboard > API Keys. Copy the **API environment variable**: `cloudinary://API_KEY:API_SECRET@CLOUD_NAME`.

## 3. Move your existing data (skip if starting fresh)
From this folder, with your old `data.db` and `uploads/` beside `package.json`:

    npm install
    export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
    export CLOUDINARY_URL='cloudinary://...'
    node scripts/migrate-to-firebase.js

Use the same VAPID keys as your old `push-vapid.json` in step 5 so phones stay subscribed.

## 4. Push to GitHub
Commit this folder to a GitHub repo (`.gitignore` already excludes secrets and the database).

## 5. Render
1. dashboard.render.com > New > **Blueprint** > pick the repo (it reads `render.yaml`). Or New > Web Service with: Build `npm ci --omit=dev`, Start `node render-server.js`, Health check `/healthz`, env `NODE_VERSION=22`.
2. Set the environment variables:
   - `CLOUDINARY_URL`
   - `FIREBASE_SERVICE_ACCOUNT`: paste the whole service-account JSON (or its base64)
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: from your old `push-vapid.json` (or generate new ones with `npx web-push generate-vapid-keys`)
3. Deploy. Open the `https://<name>.onrender.com` URL and log in.

## Notes
- Free Render services sleep after ~15 min idle; the first visit then takes ~30-60 s while data reloads from Firestore. The Starter plan stays awake.
- Each cold start reads every Firestore document once. Free quota is 50,000 reads/day, plenty for a class site unless it wakes up very often.
- Changes sync to Firestore right after each edit and every 30 s; on a Render restart it flushes first.
- Firebase Hosting cannot proxy to Render, so serve the site from Render (the `firebase.json` hosting/functions parts are only for the all-Firebase route).
