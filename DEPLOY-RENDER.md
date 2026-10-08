# Deploy for free, without a credit card (Render + Firestore + Cloudinary)

Do not use `firebase deploy` and do not click "Upgrade to Blaze". Cloud Functions, Secret Manager and
Firebase Storage need a billing account, which is why `firebase-function.js` cannot be used without a card.
This setup uses three services whose free plans need no card:

| Service | Used for |
|---|---|
| Render (free web service) | runs `render-server.js` (HTTPS included) |
| Firebase Firestore, Spark plan | keeps all data (accounts, marks, chat...) |
| Cloudinary (free) | keeps gallery photos and resource files |

Render's disk is wiped on every restart, so `render-server.js` copies the SQLite data to Firestore a few
seconds after every change and on shutdown, and reloads it on start.

## 1. Put the project on GitHub
Create a private repo and push this folder. `.gitignore` already excludes `node_modules`, `.env`, `data.db`
and `uploads/`. Never commit the Firebase key file.

## 2. Firebase (Spark plan only)
1. console.firebase.google.com -> create a project (the default Spark plan, no billing).
2. Build -> Firestore Database -> Create database (any location, production mode is fine; the server
   uses the Admin SDK, so the locked rules in `firestore.rules` are correct).
3. Project settings -> Service accounts -> Generate new private key. Keep the downloaded `.json` file private.

## 3. Cloudinary
Create a free account. On the dashboard copy the API environment variable, which looks like
`cloudinary://API_KEY:API_SECRET@CLOUD_NAME`. This is your `CLOUDINARY_URL`.

## 4. Push-notification keys (once)
On your computer: `npm install`, then `npm run vapid`. Keep the two lines it prints.
Skip this only if you do not need push alerts.

## 5. Render
New -> Web Service -> connect the GitHub repo, then:

| Setting | Value |
|---|---|
| Language | Node |
| Build command | `npm install` |
| Start command | `node render-server.js` |
| Instance type | Free |
| Health check path (Advanced) | `/healthz` |

Environment variables:

| Name | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `FIREBASE_SERVICE_ACCOUNT` | the whole contents of the downloaded key `.json` |
| `CLOUDINARY_URL` | from step 3 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | from step 4 |

Deploy. When the log says `Loaded 0 records from Firestore` and then `listening`, open the Render URL and
register ID 2504081 first (the creator account).

If startup fails, the log says why. The server refuses to start when it cannot read Firestore, so a
broken connection can never overwrite your data with an empty database.

## Already have data on your computer?
Before the first deploy, import it once. This needs `CLOUDINARY_URL` and a key file:

    set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json   (Windows; use export on Mac/Linux)
    set CLOUDINARY_URL=cloudinary://...
    node scripts/migrate-to-firebase.js

## Things to know
- Sleeping: after 15 minutes with no visitors the service sleeps; the next visit takes about a minute.
  A free pinger (for example UptimeRobot, every 5 minutes on `/healthz`) keeps it awake. One always-on
  service uses about 744 of Render's 750 free hours a month, so do not run a second free service in the same workspace.
- Firestore free limits (check the Firebase pricing page, they can change): a daily cap on reads and
  writes. Every wake-up reads all stored records once, so a very chatty class plus constant restarts could hit the
  daily cap; if it does, saves fail, are logged, and retry the next day's quota.
- Crash safety: changes are saved about 3 seconds after they happen. A hard crash can lose those last seconds.
- Updating the site: `git push`; Render redeploys and the data is reloaded from Firestore.
- Run locally as before with `npm start` (plain SQLite, no Firebase needed).
