#!/usr/bin/env bash
# TOWY TAXI — one-command server setup for Google Cloud Shell
# Usage:  bash <(curl -sL https://iramazur1991.github.io/towy_taxi/deploy-server.sh)
set -u
PROJECT=towy-taxi
FT="npx -y firebase-tools@13"
say(){ printf "\n\033[1;33m== %s ==\033[0m\n" "$1"; }

say "1/5 Checking project"
gcloud config set project "$PROJECT" >/dev/null 2>&1
echo "Switching on required Google services..."
gcloud services enable cloudbilling.googleapis.com firestore.googleapis.com --project "$PROJECT" >/dev/null 2>&1 && sleep 20
LOC=$(gcloud firestore databases describe --database='(default)' --project "$PROJECT" --format='value(locationId)' 2>/dev/null)
case "$LOC" in
  nam5) REGION=us-central1 ;;
  eur3) REGION=europe-west1 ;;
  "")   REGION=europe-west2 ;;
  *)    REGION="$LOC" ;;
esac
echo "Database: ${LOC:-unknown}  ->  server region: $REGION"

say "2/5 Writing server files"
rm -rf ~/towy-server && mkdir -p ~/towy-server/functions && cd ~/towy-server || exit 1
cat > firebase.json <<'TOWYEOF'
{ "functions": [{ "source": "functions", "codebase": "default" }], "firestore": { "rules": "firestore.rules" } }
TOWYEOF
cat > .firebaserc <<'TOWYEOF'
{ "projects": { "default": "towy-taxi" } }
TOWYEOF
cat > functions/package.json <<'TOWYEOF'
{"name":"towy-functions","private":true,"main":"index.js","engines":{"node":"22"},
 "dependencies":{"firebase-admin":"^12.7.0","firebase-functions":"^6.1.0"}}
TOWYEOF
cat > firestore.rules <<'TOWYEOF'
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function ownerDoc() { return /databases/$(database)/documents/config/owner; }
    function staffPath() { return /databases/$(database)/documents/staff/$(request.auth.uid); }
    function isOwner() { return signedIn() && exists(ownerDoc()) && get(ownerDoc()).data.uid == request.auth.uid; }
    function isStaff() { return signedIn() && exists(staffPath()) && get(staffPath()).data.active == true; }
    function isAdmin() { return isOwner() || (isStaff() && get(staffPath()).data.role == 'admin'); }

    // First account to claim this becomes the owner. Can never be changed from the app.
    match /config/owner {
      allow read: if signedIn();
      allow create: if signedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.keys().hasOnly(['uid', 'createdAt']);
    }

    // Drivers and admins. Only admins can add or change them.
    match /staff/{uid} {
      allow read: if signedIn() && (request.auth.uid == uid || isStaff());
      allow create, update: if isAdmin()
        && request.resource.data.role in ['admin', 'driver']
        && request.resource.data.active is bool;
      allow delete: if isAdmin() && uid != request.auth.uid;
    }

    // Fixed fares: public to read (customers see the usual price), admins edit.
    match /routes/{id} {
      allow read: if true;
      allow write: if isAdmin();
    }

    // Push notification tokens. Written by the apps, read only by the server.
    match /pushTokens/{id} {
      allow create, update: if signedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.role in ['client', 'staff']
        && (request.resource.data.role == 'client' || isStaff())
        && request.resource.data.token is string;
      allow delete: if signedIn() && resource.data.uid == request.auth.uid;
      allow read: if false;
    }

    match /bookings/{id} {
      // Staff see everything; a customer sees only their own rides.
      allow read: if isStaff() || (signedIn() && resource.data.uid == request.auth.uid);

      // Customers can only create a new request for themselves, without a price or driver.
      allow create: if signedIn()
        && request.resource.data.uid == request.auth.uid
        && request.resource.data.status == 'new'
        && !request.resource.data.keys().hasAny(['price', 'driverId', 'driverName', 'driverCar', 'acceptedBy', 'rating']);

      // Staff can update anything. Customers can only accept, cancel or rate.
      allow update: if isStaff() || (
        signedIn()
        && resource.data.uid == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status', 'date', 'time', 'rating'])
        && (
          (resource.data.status == 'priced' && request.resource.data.status == 'confirmed'
            && request.resource.data.date == resource.data.date && request.resource.data.time == resource.data.time)
          || (resource.data.status == 'counter' && request.resource.data.status == 'confirmed'
            && request.resource.data.date == resource.data.offerDate && request.resource.data.time == resource.data.offerTime)
          || (resource.data.status in ['new', 'priced', 'counter', 'confirmed'] && request.resource.data.status == 'cancelled'
            && request.resource.data.date == resource.data.date && request.resource.data.time == resource.data.time)
          || (resource.data.status == 'done' && request.resource.data.status == 'done'
            && !('rating' in resource.data) && request.resource.data.rating is int
            && request.resource.data.rating >= 1 && request.resource.data.rating <= 5)
        )
      );

      allow delete: if isAdmin();
    }
  }
}
TOWYEOF
cat > functions/index.js <<'TOWYEOF'
/* TOWY TAXI — server: push notifications + ride reminders */
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: "__REGION__", maxInstances: 2, memory: "256MiB" });
const APP = "https://iramazur1991.github.io/towy_taxi/";

function when(b) {
  if (!b || !b.date) return (b && b.time) || "";
  const d = new Date(b.date + "T12:00:00Z");
  const ds = isNaN(d) ? b.date : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return ds + ", " + (b.time || "");
}
const money = (v) => (typeof v === "number" ? "£" + v.toFixed(2) : "");

/* Europe/London wall-clock -> epoch ms (handles GMT/BST) */
function londonOffsetMin(ts) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" })
    .formatToParts(new Date(ts)).find((x) => x.type === "timeZoneName");
  const m = p && p.value.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const h = parseInt(m[1], 10);
  return h * 60 + (m[2] ? Math.sign(h) * parseInt(m[2], 10) : 0);
}
function londonToUtc(date, time) {
  const [y, mo, d] = String(date).split("-").map(Number);
  const [hh, mm] = String(time || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  let t = guess - londonOffsetMin(guess) * 60000;
  t = guess - londonOffsetMin(t) * 60000;
  return t;
}

async function staffRoles() {
  const s = await db.collection("staff").where("active", "==", true).get();
  const m = new Map(); s.docs.forEach((d) => m.set(d.id, d.get("role"))); return m;
}
async function send(docs, title, body, link, icon) {
  if (!docs.length) return;
  const tokens = docs.map((d) => d.get("token"));
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: { notification: { icon: APP + icon, badge: APP + icon }, fcmOptions: { link } }
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    const c = r.error && r.error.code;
    if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"].includes(c)) dead.push(docs[i].ref.delete());
  });
  await Promise.all(dead);
  logger.info("push", { title, sent: res.successCount, failed: res.failureCount });
}
async function toClient(b, title, body) {
  if (!b.uid) return;
  const s = await db.collection("pushTokens").where("uid", "==", b.uid).get();
  return send(s.docs.filter((d) => d.get("role") === "client"), title, body, APP, "icon-192.png");
}
/* onlyUids: null = all active staff; otherwise those uids + all admins */
async function toStaff(title, body, onlyUids) {
  const [s, roles] = await Promise.all([db.collection("pushTokens").where("role", "==", "staff").get(), staffRoles()]);
  const ok = s.docs.filter((d) => {
    const u = d.get("uid"); if (!roles.has(u)) return false;
    return !onlyUids || onlyUids.includes(u) || roles.get(u) === "admin";
  });
  return send(ok, title, body, APP + "driver.html", "driver-icon-192.png");
}

exports.bookingCreated = onDocumentCreated("bookings/{id}", async (e) => {
  const b = e.data && e.data.data(); if (!b) return;
  await toStaff("New booking " + (b.ref || ""), when(b) + " · " + b.from + " → " + b.to, null);
});

exports.bookingUpdated = onDocumentUpdated("bookings/{id}", async (e) => {
  const was = e.data.before.data(), b = e.data.after.data();
  if (!was || !b || was.status === b.status) return;
  const r = b.ref || "", s = b.status, p = was.status;
  const drv = b.driverId ? [b.driverId] : [];
  if (s === "priced") return toClient(b, "TOWY TAXI " + r, "Price offered: " + money(b.price) + (b.driverName ? " · driver " + b.driverName : "") + " — tap to accept");
  if (s === "counter") return toClient(b, "TOWY TAXI " + r, "We can't do " + when(b) + " — we offer " + when({ date: b.offerDate, time: b.offerTime }) + ". Tap to accept");
  if (s === "declined") return toClient(b, "TOWY TAXI " + r, "Sorry, we can't take your ride on " + when(b) + (b.reason ? " — " + b.reason : ""));
  if (s === "confirmed" && p === "new") return toClient(b, "TOWY TAXI " + r, "Your ride on " + when(b) + " is confirmed" + (b.driverName ? " · driver " + b.driverName : ""));
  if (s === "confirmed" && (p === "priced" || p === "counter")) return toStaff("Customer accepted " + r, when(b) + " · " + b.name, drv);
  if (s === "cancelled") return toStaff("Customer cancelled " + r, when(b) + " · " + b.name, drv);
});

exports.rideReminders = onSchedule({ schedule: "every 10 minutes", timeZone: "Europe/London" }, async () => {
  const now = Date.now();
  const s = await db.collection("bookings").where("status", "==", "confirmed").get();
  const jobs = [];
  s.docs.forEach((d) => {
    const b = d.data(); if (b.reminded || !b.date || !b.time) return;
    const mins = (londonToUtc(b.date, b.time) - now) / 60000;
    if (mins > 0 && mins <= 65) jobs.push((async () => {
      await d.ref.update({ reminded: true });
      await toClient(b, "Your taxi is coming up", "TOWY TAXI " + (b.ref || "") + " at " + b.time + " from " + b.from +
        (b.driverName ? " · driver " + b.driverName + (b.driverCar ? " (" + b.driverCar + ")" : "") : ""));
      if (b.driverId) await toStaff("Pick-up in " + Math.round(mins) + " min", (b.ref || "") + " · " + b.time + " · " + b.name + " · " + b.from, [b.driverId]);
    })());
  });
  await Promise.all(jobs);
});

TOWYEOF
sed -i "s/__REGION__/$REGION/" functions/index.js

say "3/5 Installing (about 1 minute)"
( cd functions && npm install --no-audit --no-fund --loglevel=error ) || { echo "npm install failed — run the command again."; exit 1; }

say "4/5 Signing in to Firebase"
if ! $FT projects:list >/dev/null 2>&1; then
  echo "Open the link below, pick your Google account, press Allow,"
  echo "copy the code it shows and paste it here, then press Enter."
  $FT login --no-localhost || { echo "Sign-in didn't finish — run the command again."; exit 1; }
fi

say "5/5 Uploading to Google (3-6 minutes, lots of text is normal)"
if $FT deploy --only functions,firestore:rules --project "$PROJECT" --force --non-interactive; then
  say "DONE — TOWY TAXI server is live"
  echo "Check: Firebase console -> Functions: bookingCreated, bookingUpdated, rideReminders"
else
  echo
  echo "Something failed. If the red text mentions Eventarc, permission or 'retry',"
  echo "that's normal on the very first setup: wait 5 minutes and run the SAME command again."
  echo "Otherwise take a screenshot of the red text and send it to Claude."
  exit 1
fi
