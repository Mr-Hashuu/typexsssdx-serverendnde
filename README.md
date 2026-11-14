# Typex Server

One server for every Typex Board phone:

- **Admin panel** (open the site URL): send a notification to every phone, publish an app update, see how many phones are connected and which versions they use.
- **Phones connect by themselves**: the app pings the server (anonymous random id, app version, phone model), checks for messages every hour and when the keyboard opens, and checks for updates every hour.
- **Surveys**: write questions in the admin panel (Surveys page), phones show them in the app dashboard, you see live results with percentages, download all answers as CSV, clear them, or publish a new survey any time. Each phone has one answer per survey (it can change it).
- **Phone control**: Overview shows new phones per day (14 days), Android versions, top phone models and versions. Phones page has search, CSV download and a Remove button.
- **Payments (manual approval)**: admin panel > Payments. Users open Premium in the app, pick a plan, pay to your bank / eZ Cash account, and type the payment reference. The request appears in **Waiting**; you check your account, press **Approve** (premium turns on for that phone and time is added) or **Reject** (with a reason the user sees). Income today / 7 days / 30 days / all time, a 14-day chart, active premium phones, CSV download, and a Premium button on the Phones page to gift or remove days. **Premium OFF = every feature stays free** (switch it on in Payments > Premium settings when you are ready).
- **Updates**: you publish a version + APK link (or let the server follow your GitHub releases). Phones download it, show the install notification, or show "Update required" if you switch Required on.

## Deploy on Render (free)

1. Make a free MongoDB Atlas cluster. Database Access: add a user. Network Access: allow 0.0.0.0/0. Copy the connection string (mongodb+srv://...).
2. Push this folder to a GitHub repo.
3. Render: New > Web Service > pick the repo. Build command `npm install`, start command `npm start`. 
4. Open `config.js`, fill `mongodbUri`, `adminPassword` and `sessionSecret` before you push. No environment variables are needed. Keep the GitHub repo private.
5. Open `https://YOUR-SERVICE.onrender.com`, sign in with the admin password.

Free Render services sleep after 15 minutes without requests and the first request takes up to about a minute. The app waits for that, so it still works. To keep it awake, add a free uptime monitor (UptimeRobot) that opens `/health` every 5 minutes.

## Connect the app

Open `app/src/main/res/values/server.xml` in the app project, put your address in `server_url` (no slash at the end), build and release the app. Every phone with that build now talks to your server.

## Publish an update

1. Raise `versionName` / `versionCode` in `app/build.gradle.kts`, push, let GitHub Actions build the release (the APK is called `Lipi-<version>.apk`).
2. Admin panel > App updates > Manual: version, APK link (the release asset), what is new, Required if you want. Publish.
   Or choose GitHub releases, enter `owner/name`, and every new release is picked up by itself.

## Run locally

```
npm install
npm start     # with an empty mongodbUri in config.js data is kept in memory only
npm test                          # end to end test of the API
```

## API (used by the app)

| Call | Purpose |
|---|---|
| `GET /api/update` | `{versionName, notes, apk, page, force}`, the same shape the app's updater already reads |
| `POST /api/ping` | `{id, v, model, sdk}` registers or refreshes a phone; the answer also carries `premiumOn`, `premiumUntil`, `premiumPlan` |
| `GET /api/messages?since=<ts>&v=<version>&id=<id>` | messages newer than `since` for this version |
| `GET /api/survey` | the live survey `{id, title, questions:[{id, q, options, multi}]}` (built-in questions until you publish one) |
| `POST /api/survey` | `{id, survey, v, answers:{questionId:[option,...]}}`, every question must be answered with its own options |
| `GET /api/premium?id=<phone id>` | `{enabled, plans, payInfo, until, active, plan, requests:[...]}` for the Premium screen |
| `POST /api/premium/request` | `{id, plan, ref, name}` creates a waiting payment request (one reference can be used once; 3 waiting per phone) |
| `POST /api/ack` | `{id, msg}` counts a message as delivered once per phone |
