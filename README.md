# CUET CSE '25 — dynamic site

Needs Node.js 22.5 or newer.

## Firebase + Cloudinary deployment

The deploy target serves the existing frontend from Firebase Hosting, routes `/api/**` to a Node 22 Firebase Function in `asia-south1`, mirrors application records to Firestore, and stores uploaded media in Cloudinary. The SQLite file remains a local development database; Functions use a temporary SQLite working copy and sync it to Firestore. This adapter serializes API traffic through one function instance, so it is intended for a small class site rather than a high-traffic service.

1. Create a Firebase project, enable Firestore in Native mode, and choose `asia-south1` (Firestore location is fixed after creation). Enable billing for Cloud Functions.
2. Install the Firebase CLI, sign in with `firebase login`, then run `firebase use --add` from this folder to select your project.
3. Create a Cloudinary account and get its `CLOUDINARY_URL`. Set the three Function secrets. Use the same VAPID key pair from your existing `push-vapid.json` so subscribed devices remain valid:

       firebase functions:secrets:set CLOUDINARY_URL
       firebase functions:secrets:set VAPID_PUBLIC_KEY
       firebase functions:secrets:set VAPID_PRIVATE_KEY

   The CLI prompts for each value. Keep the private key and Cloudinary URL out of source control.
4. Install dependencies with `npm install`. Before the first deployment, import the local database and assets. Authenticate Firebase Admin with Application Default Credentials for the selected project (for example, `gcloud auth application-default login`), then run:

       node scripts/migrate-to-firebase.js

   The migration uploads gallery images, resource files, and embedded profile/chat photos to Cloudinary, then imports the SQLite records into Firestore. It is repeatable; retain a backup of `data.db` and `uploads/` until you verify the deployed site.
5. Deploy Hosting, Functions, and the Firestore deny-by-default rules:

       firebase deploy

   Firestore client access is denied because the app accesses it through the server-side Admin SDK. The Function uses one instance to keep the SQLite working copy consistent; expect requests to queue if many users hit it at once.

The migration script requires an existing `data.db`. If starting with a fresh install, start the local server once to create and seed it, then run the migration. For local development, `npm start` still runs the app on port 3000 and SQLite remains local.

    npm install
    node server.js          # then open http://localhost:3000

- Database: SQLite file `data.db`, created on first run (back it up to keep your data).
- Only roll numbers 2504001-2504132 can register or log in. ID 2504081 is the site developer: that account is always an admin.
- Only admins can change shared content (routine, courses, CTs, vacations, notices, resources,
  projects, polls, calendar events, session dates). Admins and CRs have the same edit rights; only the developer (2504081) chooses who is an admin and who is a CR (Classmates tab).
- Students can vote in polls and manage only their own data: attendance and profile. The calendar is admin-only: admins add events (for Everyone, a Section or a Group) and students see the ones that apply to them. Personal events created before this change stay visible only to their owner, who can delete them.
- Passwords are hashed (scrypt). Sessions use an HttpOnly cookie. Login attempts are rate-limited.
- Hosting: any Node host with a persistent disk works (Render, Railway, Fly.io, a VPS).
  Set PORT and DB_FILE (path on the persistent disk) as environment variables.
- Push notifications: `web-push` sends notices, tests, polls and new resource alerts to subscribed devices. Serve the site over HTTPS, log in on each device, and tap the bell once to grant notification permission and subscribe. Per-account category preferences are under Dashboard → Alerts. For production, keep `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` stable in the host's secret environment; `VAPID_SUBJECT` defaults to the class contact email. If those keys are omitted, the server creates `push-vapid.json` beside the database, so that file must be on persistent storage and backed up with the database. Changing the VAPID key invalidates existing device subscriptions.
- Offline use: the PWA caches its app shell for offline launch. In Dashboard → Resources, use **Save offline** on files you want to keep on the device. The offline dashboard lists those files and saved resource links; live schedule and account data refresh when the server is reachable. Offline file saves are cleared when you log out on that device.
- Phone home-screen widgets: native Android and iPhone companion-app sources are in `native/`. Enter the computer's LAN URL (for example `http://192.168.1.5:3000`) in the app, sign in, then add the CUET CSE 25 widget from the phone's widget gallery. It shows the saved next-class, academic-week and unread-alert snapshot, and refreshes when the companion app opens. See `native/README.md` for setup; Android Studio is needed for Android, while iOS requires a Mac with Xcode and an App Group configured for signing.
- Restart `node server.js` after updating so SQLite creates the notification-preferences table.

## Sections and groups
Roll 2504001-2504066 = Section A (A1: 001-033, A2: 034-066). The rest = Section B, split the same way.
The last roll number of each section is editable by the admin on the Profile tab (default: A ends at 66, B ends at 132).
Routine, CTs and notices can be targeted at Everyone, a Section, or a Group; students only see what applies to them.

## Official routine
The routine, courses (with teachers), Section A/B classrooms (3303 / 3307), lab groups and the class-test schedule follow the department's Level-1 Term-I (Batch 2025) PDF; classes commence 5 July 2026.
A fresh database is seeded with it automatically. For an existing database, log in as admin, open Routine and press "Load official routine" (this replaces routine, courses and class tests, and resets attendance counts). Session end date is a placeholder; set it on the Profile tab.

## Sound
Sound effects now work inside the dashboard (clicks, hover, typing, saved/error tones). Use the ♪ button in the dashboard header to mute or unmute; the choice is remembered.

## Feature pack (added)
`public/x.js` extends the dashboard; `server.js` gained the matching routes.
- Calendar: Month / Week / Agenda views, type filters (class, sessional, CT, event, vacation).
- Routine: period grid per group (A1/A2/B1/B2) with labs spanning their periods, break/lunch rows, today highlighted.
- Courses: theory/sessional split, detail panel (overview, CTs, files, your marks), attendance "how many can I miss" hint.
- CT: tests by month, cancel/restore, syllabus, your private marks, per-course summary.
- Resources: level > term > course explorer with folders.
- Notices reader pane with clickable links; timed Polls (open/results, results hidden until you vote, auto-purged).
- Alerts feed with unread badge, Chat (batch + section rooms, photos, 7-day expiry), Feedback inbox, Classmates directory.
- Profile: photo, social links, hometown, school/college, password change.

## Round 2 changes
- Home: "Open tests" and "Open calendar" links. New Today page (only today's classes, tests, events, notices, files, open polls).
- Calendar: Month / Week (7-column board) / Day / Agenda, with working previous/next for every view.
- Tests: CT for theory courses; Quiz and Lab test for sessionals (the server enforces this). Marks are listed separately per type.
- Resources: real folder tree (Level > Term > Course > anything). Admin creates folders, uploads files (max 25 MB, stored in an `uploads/` folder next to the database) and adds links. Hover a row for download; folders download as .zip. Back up `uploads/` together with `data.db`.
- Chat: Universal, Section and Group (A1/A2/B1/B2) rooms.
- Classmates now includes Members: everyone sees roles; admins promote/demote there.
- Profile: only admins can export data.

## Round 3 changes
- Dashboard navigation uses SVG icons (no emojis). The ☰ button in the header collapses the panel to icons only (hover shows the name) and expands it again; the choice is remembered.
- The Today page is removed. Home still shows today's and tomorrow's classes.
- Tests has sub-sections: CT, Quiz, Term final, Summary. Sessional courses show "Quiz" (the old "Lab test" is gone; existing ones become Quiz on startup).
  CT: any number per theory course. Quiz: exactly one per sessional course. Term final: exactly one per theory course (the server enforces this).
- Admin form is now "Add tests"; the course list follows the chosen type.
- Feedback shows the site developer (ID 2504081) with a big photo. Name, school/college, hometown and links come from his Profile; the photo is his profile photo, or `public/developer.jpg (or the older creator.jpg)` if he has not uploaded one.

## Round 4 changes
- Courses (sessional): overview shows Next quiz and Next lab test; the tab is "Quiz & Lab test"; students save their own quiz / lab test marks in the Marks tab.
- Tests: tabs (CT, Quiz, Lab test, Term final, Summary) are at the top; each tab has its own Total / Scheduled / Done / Cancelled boxes and inline mark entry.
  Rules: CT = theory, many allowed. Quiz = sessional, one per course. Lab test = sessional, many allowed. Term final = theory, one per course.
- Admin: "Add marks" (under "Add tests") saves a mark for any student ID on any test.
- No emoji anywhere: all icons are inline SVG (nav, alerts, resources, notices pin, chat attach, password show/hide, top bar).
- Feedback page order: feedback form (and admin inbox), Class Representatives (all admins, no pictures), then the developer card (smaller photo).

## Round 5 changes
- Greeting: "Good Afternoon" now starts at 1 PM (12:00-12:59 still says Good Morning).
- Alerts: the bell shows just the number (no red dot); 9+ above nine.
- Tests > Summary: the overall "Total" box is gone (per-course cards keep theirs).
- Calendar: admins pick the type (Class, Sessional, Test, Event, Vacation) with a colour chooser and optional start/end time. Month view is Google-Calendar style with large coloured event chips (+N more); the legend and the filter buttons show the colour swatch of each type.
- Courses: admins choose Theory or Sessional when adding a course (older courses fall back to the old auto-detection).
- Resources: a real explorer. Folder tree on the left (expand/collapse), contents and breadcrumbs on the right.
- Chat admin privileges: admins can read and post in every room (batch, sections, groups), pin or delete any message, and clear a room. Admin messages carry an ADMIN tag; students can delete their own messages.
- Classmates: tap a name for a detail card (photo, section/group, school, college, hometown, links, birthday). Email, phone and blood group are shown only to admins and to the person themselves.
- Feedback: new wording, a category (Suggestion, Bug, Content request, Praise, Other), a character counter and an anonymous option. The admin inbox shows the category.
- Profile: the session start/end and "last roll no." fields are removed from the form. The stored values stay as they were (the server keeps them when the form does not send them).

## Round 6 changes
- Sidebar title is now "Dashboard". Navigation order: Home, Calendar, Vacation, Routine, Courses, Tests, Resources, Notices, Chat, Polls, Alerts, Classmates, Projects, Gallery, Feedback, Profile.
- Calendar: the colour legend is gone (the type selector already shows the colours).
- Tests > Summary: two separate parts, "CT summary" (theory courses) and "Quiz summary" (sessional courses, Total 1 / Done / Left). No status boxes and no term final summary.
- Roles: the developer (2504081, always an admin) picks admins and CRs in Classmates and can remove either at any time. Admins and CRs both get full edit access. Nobody else can change roles. Chat messages carry an ADMIN or CR tag.
- Feedback: the Class Representatives box lists only the CRs, with new wording. Anonymous feedback shows as "Anonymous" in the inbox.
- Alerts: read/unread marks are saved on the account (not in the browser), so the bell number is the same on every device. Your own notices, tests, files and polls no longer count as unread alerts for you.
- Gallery (new): shared photo wall with albums, captions and a full-screen viewer (arrow keys / Esc). Any student can add photos (JPEG, shrunk in the browser, up to 6 at a time, 3 MB each, 400 photos total); owners and admins can delete. Photos are stored in the `uploads/` folder, so back it up with `data.db`.
- Login: only 2504001-2504132. An old account with any other ID can no longer sign in.

## Round 7 changes
- Search is gone everywhere: the students search box, the command palette (Ctrl+K and /) and the Classmates search box.
- Colour palette fixed: Main colour and Sub colour each show two rows of four presets, then a third row with a custom colour picker and a Default button. (The old layout was squashed by a clashing `.sw` style; the palette now uses its own `.csw` class.)
- Public site: Students says "Admitted through the admission exam from different parts of the country, now one department."; Projects says "Builds and prototypes from across the department."; About the batch always shows 132 Students and 41 Faculty (the Projects count is replaced by Faculty).
- Contact: u2504081@student.cuet.ac.bd with a "Send us an email" button (the old placeholder cse25@example.com is removed).

## Round 8 changes
- Public Gallery now shows the real photos from the database, the same ones as the dashboard Gallery tab (new public route `/api/gallery`; `/api/photo/:id` no longer needs a login so the main page can show them). Photos added in the dashboard appear on the main page on the next page load, and deleting one removes it from both. Click a photo for a full-screen viewer (arrows / Esc).
- Gallery layout (public page and dashboard): 4 photos per row, extra photos wrap onto new rows (2 per row on phones).
- Students: search box (name or ID) above a 3-profile slideshow ordered by ID. The middle profile is larger; arrows (and swipe, or arrow keys) move it right to left or back, it loops, and it advances by itself every few seconds (pauses on hover, while searching, or if the visitor prefers reduced motion). Click a side profile to bring it to the middle, click the middle one to open its dossier. Searching shows only the matching student(s) with no slideshow; clearing the box brings the slideshow back. The group filter buttons still work.


## Clean URLs (no #)
Dashboard pages live at real paths: `/home /calendar /courses /tests /resources /notices /chat /classmates /projects /gallery /feedback /profile /members`.
The public site uses `/students /projects /gallery /about /contact /developer` (these scroll to the section). Old `#/cts`-style links are converted automatically.
`server.js` returns the app for any path without a file extension; for Firebase Hosting `firebase.json` has the matching `**` -> `/index.html` rewrite.
Developer card (Contact area, `/developer`): shows the Profile of roll 2504081. Phone/email come from that Profile; if empty, set `DEVELOPER_PHONE` / `DEVELOPER_EMAIL` env vars.
