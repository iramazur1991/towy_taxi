/* TOWY TAXI — shared core */
window.TT = (function () {
  "use strict";
  var CFG = {
    apiKey: "AIzaSyCymQ-rMRexbui_M6UiFvA9NX2fr9wM34M",
    authDomain: "towy-taxi.firebaseapp.com",
    projectId: "towy-taxi",
    storageBucket: "towy-taxi.firebasestorage.app",
    messagingSenderId: "545252559547",
    appId: "1:545252559547:web:c370e91c47fa02ff63b79e"
  };
  var APP_URL = "https://iramazur1991.github.io/towy_taxi/";
  var NTFY_TOPIC = "towy-taxi-bbvca4h9pj";

  function init(name) {
    var app = (!name || name === "[DEFAULT]") ? firebase.initializeApp(CFG) : firebase.initializeApp(CFG, name);
    return { app: app, auth: app.auth(), db: app.firestore() };
  }
  function secondaryAuth() {
    var a = firebase.apps.filter(function (x) { return x.name === "creator"; })[0] || firebase.initializeApp(CFG, "creator");
    var au = a.auth();
    return au.setPersistence(firebase.auth.Auth.Persistence.NONE).then(function () { return au; });
  }

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function normPhone(p) {
    p = String(p || "").replace(/[\s\-().]/g, "");
    if (/^\+447\d{9}$/.test(p)) p = "0" + p.slice(3);
    if (/^447\d{9}$/.test(p)) p = "0" + p.slice(2);
    if (!/^07\d{9}$/.test(p)) return null;
    return p.slice(0, 5) + " " + p.slice(5);
  }
  function toE164(p) { var n = normPhone(p); return n ? "+44" + n.replace(/\s/g, "").slice(1) : null; }
  function normPc(s) {
    s = String(s || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!s) return "";
    if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(s)) return null;
    return s.slice(0, s.length - 3) + " " + s.slice(-3);
  }
  function fmtWhen(b) {
    var d = b.date ? new Date(b.date + "T00:00:00") : null;
    var ds = d && !isNaN(d) ? d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : (b.date || "");
    return ds + ", " + (b.time || "");
  }
  var CHIP = {
    new: ["s-new", "Waiting for confirmation"], priced: ["s-counter", "Price offered"],
    confirmed: ["s-confirmed", "Confirmed"], declined: ["s-declined", "Declined"],
    counter: ["s-counter", "New time offered"], cancelled: ["s-cancelled", "Cancelled"], done: ["s-done", "Completed"]
  };
  function chip(st) { var c = CHIP[st] || ["s-done", esc(st)]; return '<span class="chip ' + c[0] + '">' + c[1] + "</span>"; }
  function money(v) { return typeof v === "number" ? "£" + v.toFixed(2) : ""; }
  function makeRef() { var c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = ""; for (var i = 0; i < 4; i++) r += c.charAt(Math.floor(Math.random() * c.length)); return "TT-" + r; }

  function lookupPc(pc) {
    return fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(pc))
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.status === 200 && j.result) ? j.result : null; })
      .catch(function () { return undefined; });
  }
  function pcCheck(inputId, infoId, onDone) {
    var el = $(inputId), info = $(infoId); if (!el || !info) return;
    el.addEventListener("blur", function () {
      var pc = normPc(el.value); info.className = "hint"; info.textContent = "";
      if (!pc) return;
      el.value = pc;
      lookupPc(pc).then(function (r) {
        if (r === undefined) return;
        if (!r) { info.className = "hint badc"; info.textContent = "\u2717 Postcode not found — please check it"; return; }
        info.className = "hint okc";
        info.textContent = "\u2713 " + [r.parish || r.admin_ward, r.admin_district].filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(", ");
        if (onDone) onDone();
      });
    });
  }

  /* Fixed fares: route {a, b, price}. Keys are town names or postcode districts (SA31). Both directions. */
  function keyMatch(key, text, pc) {
    var k = String(key || "").trim().toUpperCase(); if (!k) return false;
    if (/^[A-Z]{1,2}\d[A-Z\d]?$/.test(k)) { var d = String(pc || "").trim().toUpperCase().split(/\s+/)[0]; if (d === k) return true; }
    return (String(text || "") + " " + String(pc || "")).toUpperCase().indexOf(k) >= 0;
  }
  function findFare(routes, b) {
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if ((keyMatch(r.a, b.from, b.fromPc) && keyMatch(r.b, b.to, b.toPc)) || (keyMatch(r.b, b.from, b.fromPc) && keyMatch(r.a, b.to, b.toPc))) return r.price;
    }
    return null;
  }

  /* Alerts */
  var actx = null;
  function unlockAudio() { try { if (!actx) { var C = window.AudioContext || window.webkitAudioContext; if (C) actx = new C(); } if (actx && actx.state === "suspended") actx.resume(); } catch (e) {} }
  document.addEventListener("click", unlockAudio, { passive: true });
  document.addEventListener("touchstart", unlockAudio, { passive: true });
  function beep() {
    try {
      unlockAudio(); if (!actx) return;
      [0, 0.25].forEach(function (t) {
        var o = actx.createOscillator(), g = actx.createGain(); o.type = "sine"; o.frequency.value = t ? 1175 : 880;
        var s = actx.currentTime + t; g.gain.setValueAtTime(0.3, s); g.gain.exponentialRampToValueAtTime(0.001, s + 0.35);
        o.connect(g); g.connect(actx.destination); o.start(s); o.stop(s + 0.36);
      });
    } catch (e) {}
  }
  function alertUser(title, body, icon) {
    beep();
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
    try {
      if (window.Notification && Notification.permission === "granted" && navigator.serviceWorker) {
        navigator.serviceWorker.ready.then(function (r) { r.showNotification(title, { body: body, icon: icon || "icon-192.png", tag: "towy-" + Date.now() }); }).catch(function () {});
      }
    } catch (e) {}
    var t = document.title; document.title = "\u25CF " + title; setTimeout(function () { document.title = t; }, 6000);
  }
  function askNotify() { try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) {} }
  function notifyDriver(b) {
    try {
      fetch("https://ntfy.sh/", { method: "POST", body: JSON.stringify({
        topic: NTFY_TOPIC, title: "TOWY TAXI — new booking",
        message: (b.ref || "") + " · " + b.date + " " + b.time + " · open TOWY Driver to respond",
        tags: ["taxi"], priority: 4, click: APP_URL + "driver.html" }) }).catch(function () {});
    } catch (e) {}
  }

  /* Modals */
  function openModal(id) { $(id).classList.add("open"); }
  function closeModal(id) { $(id).classList.remove("open"); }

  /* Map picker (Leaflet + OpenStreetMap). o: {btn, wrap, map, info, loc, pc, fill, setLabel} */
  function picker(o) {
    var map = null, mk = null, ll = null, B = $(o.btn), W = $(o.wrap), I = $(o.info), base = B.textContent;
    function set(lat, lng) {
      if (!mk) mk = L.circleMarker([lat, lng], { radius: 11, color: "#17150F", weight: 3, fillColor: o.fill, fillOpacity: 1 }).addTo(map);
      else mk.setLatLng([lat, lng]);
      ll = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
      I.className = "hint okc"; I.textContent = "\u2713 Pin set — tap again to move it"; B.textContent = o.setLabel;
    }
    function open() {
      if (W.style.display !== "none" && map) { W.style.display = "none"; return; }
      W.style.display = "";
      if (!map) {
        if (!window.L) { I.textContent = "Map couldn't load — add directions in the notes"; return; }
        map = L.map(o.map).setView([51.8576, -4.3121], 13);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
        map.on("click", function (e) { set(e.latlng.lat, e.latlng.lng); });
      }
      setTimeout(function () {
        map.invalidateSize();
        if (ll) { map.setView([ll.lat, ll.lng], 17); return; }
        var pc = normPc($(o.pc).value);
        if (pc) lookupPc(pc).then(function (r) { if (r) map.setView([r.latitude, r.longitude], 17); });
      }, 60);
    }
    B.addEventListener("click", open);
    $(o.loc).addEventListener("click", function () {
      if (!navigator.geolocation) { I.textContent = "Location not available — tap the map"; return; }
      I.className = "hint"; I.textContent = "Finding you…";
      navigator.geolocation.getCurrentPosition(function (p) {
        map.setView([p.coords.latitude, p.coords.longitude], 17); set(p.coords.latitude, p.coords.longitude);
      }, function () { I.className = "hint badc"; I.textContent = "Couldn't get your location — tap the map instead"; },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
    return {
      get: function () { return ll; },
      reset: function () {
        ll = null; if (mk && map) map.removeLayer(mk); mk = null; B.textContent = base; W.style.display = "none";
        I.className = "hint"; I.textContent = "Tap the map to drop a pin";
      }
    };
  }

  function mapsLink(lat, lng, text) {
    var dest = lat ? (lat + "," + lng) : text;
    return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(dest);
  }
  function routeLink(b) {
    var o = b.pickLat ? b.pickLat + "," + b.pickLng : b.from + (b.fromPc ? ", " + b.fromPc : "");
    var d = b.dropLat ? b.dropLat + "," + b.dropLng : b.to + (b.toPc ? ", " + b.toPc : "");
    return "https://www.google.com/maps/dir/?api=1&origin=" + encodeURIComponent(o) + "&destination=" + encodeURIComponent(d);
  }

  return {
    CFG: CFG, APP_URL: APP_URL, NTFY_TOPIC: NTFY_TOPIC, init: init, secondaryAuth: secondaryAuth,
    $: $, esc: esc, normPhone: normPhone, toE164: toE164, normPc: normPc, fmtWhen: fmtWhen, chip: chip, money: money,
    makeRef: makeRef, lookupPc: lookupPc, pcCheck: pcCheck, findFare: findFare, beep: beep, alertUser: alertUser,
    askNotify: askNotify, notifyDriver: notifyDriver, openModal: openModal, closeModal: closeModal, picker: picker,
    mapsLink: mapsLink, routeLink: routeLink
  };
})();
if ("serviceWorker" in navigator) { window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); }); }
