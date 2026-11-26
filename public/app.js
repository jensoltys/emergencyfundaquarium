// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
'use strict';

// The tab (or day) the user was on before they hit refresh. history.state
// survives a reload of the same entry, but init() replaceState()s an
// auth-landing entry over it before enterApp() ever runs, so it has to be captured HERE, at module load,
// before anything touches history. Without it, refreshing anywhere but the
// default tab bounced the user back to the default.
const BOOT_VIEW = (history.state || {}).view || null;
// Same idea for the logged-out side: a refresh on the sign-up card or on the
// guest "build your tank" steps lands back there, not on the default.
const BOOT_ENTRY = (() => { const st = history.state || {}; return { authView: st.authView || null, guestView: st.guestView || null }; })();

// ── Boot gate ────────────────────────────────────────────────────────────────
// #auth-screen is hidden in the markup, so the logged-out card cannot paint over
// a session that is seconds from resolving. The call is made here,
// synchronously, before any network request.
function showAuthScreen() {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.style.display = 'none';
  const auth = document.getElementById('auth-screen');
  if (auth) auth.style.display = 'flex';
}
function hideBootScreen() {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.style.display = 'none';
}
// The session is an HttpOnly cookie the page can't read, so the boot screen
// stays up until init() asks GET /api/me (401 = show the login card). A
// logged-in user never sees the login card flash, and a logged-out one sees
// the boot screen for one round trip.
(function bootGate() {
  const msg = document.getElementById('boot-msg');
  if (msg) msg.textContent = 'Opening your tank…';
})();

// ── Overlay stack ────────────────────────────────────────────────────────────
// One owner for "which overlay is on screen". Every modal used to flip its own
// .style.display, which produced two bugs:
//
//   1. Stacked dialogs. Opening the Pro gate from the goal form's biome picker
//      painted its dark backdrop over the still-visible goal card — two
//      dialogs at once. Opening B now hides
//      A. Only `display` moves, so a half-filled goal form keeps every value
//      and comes back intact when B closes.
//   2. Back left the site. No overlay pushed a history entry, so a free user
//      who hit the Pro gate and pressed Back went straight off the origin.
//      The 2026-07 retrofit covered the tabs, the fund switcher and the auth
//      steps but not the modals; popstate -> closeAllOverlays() was already
//      wired, it just never had an entry to pop. Each open now consumes
//      exactly one Back press.
//
// A `gate` overlay is the exception: a blocking, un-skippable state shown at
// the app's landing (first-run onboarding, and the goal modal when the account
// has no funds at all). There is nothing to go back TO, so it pushes nothing
// and Back from it leaves the app like any other landing view.
//
// Depth is counted in PUSHED layers, not stack length — a gate sitting under a
// pushed layer must not shift the number popstate compares against.
let overlayStack = []; // [{ id, pushed }] bottom -> top
function overlayPushedCount() { let n = 0; for (const o of overlayStack) if (o.pushed) n++; return n; }
function overlayIsOpen(id) { const el = document.getElementById(id); return !!(el && el.style.display && el.style.display !== 'none'); }
function setOverlayShown(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  const was = overlayIsOpen(id);
  el.style.display = on ? 'flex' : 'none';
  if (on && !was) trapFocus(el, document.activeElement);
  else if (!on && was) releaseFocus(el);
}

// ── Dialog focus ────────────────────────────────────────────────
// Every overlay is shown and hidden through setOverlayShown above, so this is
// the one place focus is handled: on open it moves into the dialog, Tab and
// Shift+Tab stay inside the top dialog, and on close it goes back to whatever
// opened it. Escape is handled by the keydown listener further down.
const FOCUSABLE_SEL = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function focusablesIn(el) { return [...el.querySelectorAll(FOCUSABLE_SEL)].filter(n => n.getClientRects().length > 0); }
function topOpenDialog() {
  const tb = document.getElementById('tourbox'); if (tb) return tb;
  for (let i = overlayStack.length - 1; i >= 0; i--) { const el = document.getElementById(overlayStack[i].id); if (el && overlayIsOpen(el.id)) return el; }
  return null;
}
// Last element focused outside the open dialog: some openers move focus into
// the dialog themselves, and stacked layers hand focus around, so this keeps
// the real opener.
let lastFocusOutside = null;
document.addEventListener('focusin', (e) => { const d = topOpenDialog(); if (!d || !d.contains(e.target)) lastFocusOutside = e.target; }, true);
function trapFocus(el, opener) {
  if (!opener || opener === document.body || el.contains(opener)) opener = lastFocusOutside;
  el._efaOpener = opener && opener !== document.body && !el.contains(opener) ? opener : null;
  // Paint first: the dialog's contents may only become visible this frame.
  requestAnimationFrame(() => {
    if (!overlayIsOpen(el.id) || el.contains(document.activeElement)) return;
    const f = focusablesIn(el);
    if (f.length) f[0].focus();
    else { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1'); el.focus(); }
  });
}
function releaseFocus(el) {
  const o = el._efaOpener; el._efaOpener = null;
  if (o && o.isConnected && o.getClientRects().length && !topOpenDialog()) o.focus();
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const d = topOpenDialog();
  if (!d) return;
  const f = focusablesIn(d);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || !d.contains(a))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (a === last || !d.contains(a))) { e.preventDefault(); first.focus(); }
});

// Teardown for a layer the user ABANDONED (Escape, backdrop, or Back) — it
// does not run on consumeOverlay(), where the layer's own handler already
// settled its state. Back on a celebration means "I'm done celebrating", so it
// drains the whole queue; "Keep Going" means the opposite and consumes instead.
const OVERLAY_TEARDOWN = {
  'celeb-overlay': () => { milestoneQueue = []; pendingDepositPopup = null; },
  // The tour has no overlay element of its own — it paints a ring plus a pinned
  // box onto the body — so popping its layer is what tears it down.
  'tour-layer': () => { endTour(true); },
  'confirm-modal': () => { if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); } },
};

function openOverlay(id, { gate = false } = {}) {
  const top = overlayStack[overlayStack.length - 1];
  if (top && top.id === id) return;          // already the visible layer
  // The goal form's Cancel only exists when there is something to go back to:
  // as the no-funds gate it is the only screen the account has.
  if (id === 'goal-modal') {
    const cancel = document.getElementById('goal-modal-cancel');
    if (cancel) cancel.style.display = gate ? 'none' : '';
  }
  if (top) setOverlayShown(top.id, false);   // one dialog at a time
  setOverlayShown(id, true);
  overlayStack.push({ id, pushed: !gate });
  if (!gate) history.pushState({ ...(history.state || {}), efaOverlay: overlayPushedCount() }, '', location.pathname + location.search);
}

// Drops the top layer and reveals whatever it covered. teardown=false is the
// consumeOverlay() path, where the layer's own handler already settled state.
function popOverlayLayer(teardown = true) {
  const layer = overlayStack.pop();
  if (!layer) return;
  setOverlayShown(layer.id, false);
  const fn = teardown ? OVERLAY_TEARDOWN[layer.id] : null;
  if (fn) fn();
  const restore = overlayStack[overlayStack.length - 1];
  if (restore) setOverlayShown(restore.id, true);
}

// Returns true when the close was handed off to history — popstate does the
// hiding in that case, so the caller must NOT also hide the element or the
// on-screen button and the browser Back button fall out of sync (dead presses).
// fromHistory=true means popstate is already unwinding; hide directly or
// calling history.back() again would loop.
function closeOverlay(id, fromHistory) {
  const idx = overlayStack.map(o => o.id).lastIndexOf(id);
  if (idx === -1) { setOverlayShown(id, false); return false; } // opened outside the stack
  if (!fromHistory && overlayStack[idx].pushed && (history.state || {}).efaOverlay) { history.back(); return true; }
  while (overlayStack.length > idx) popOverlayLayer();
  return false;
}

// An action completed INSIDE an overlay (creating the fund) consumes that
// overlay's history entry instead of leaving a dead one behind — the modal is
// gone, so Back must skip past it. Same reasoning as using location.replace()
// for a page whose action consumed it.
function consumeOverlay(id) {
  const idx = overlayStack.map(o => o.id).lastIndexOf(id);
  if (idx === -1) { setOverlayShown(id, false); return; }
  const pushed = overlayStack[idx].pushed;
  while (overlayStack.length > idx) popOverlayLayer(false);
  if (pushed) pushViewState(true); // replaceState over the now-stale overlay entry
}

// Escape dismisses the top layer. These are role="dialog" aria-modal="true"
// and had no keyboard exit at all. Routed through the same close path as the
// on-screen buttons, so Escape and browser Back stay in sync. Gates are
// deliberately un-dismissable — there is no app behind them yet.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = overlayStack[overlayStack.length - 1];
  if (!top || !top.pushed) return;
  e.preventDefault();
  if (top.id === 'confirm-modal') closeConfirm(false);
  else if (top.id === 'celeb-overlay') closeCeleb();
  else closeOverlay(top.id);
});

// Clicking the dimmed backdrop of a stacked dialog dismisses it, the same as
// Escape. The Pro modal has its own backdrop element (data-action) already.
document.addEventListener('click', (e) => {
  const top = overlayStack[overlayStack.length - 1];
  if (!top || !top.pushed) return;
  if (top.id === 'confirm-modal' || top.id === 'pro-required-modal') return; // own handlers
  if (e.target.id !== top.id) return; // only the overlay element itself, not its card
  if (top.id === 'celeb-overlay') closeCeleb(); else closeOverlay(top.id);
});

// Unwinds to the pushed-layer depth a popped history entry describes. Gates
// sitting below the target survive, which is what makes Back from the Pro
// modal land on the goal form rather than on the bare tank.
function unwindOverlaysTo(depth) {
  let guard = overlayStack.length + 1;
  while (overlayPushedCount() > depth && guard-- > 0) popOverlayLayer();
  // A trailing gate with nothing pushed above it stays put by design.
}

// ── Unified Pro-required modal ──────────────────────────────────────────────
const PRO_FEATURE_COPY = {
  'unlimited-goals': { title: 'Unlimited savings goals' },
  'pro-biomes': { title: 'Pro aquarium themes' },
};
function showProRequired(feature) {
  // Pro only exists on the hosted version, so say that plainly.
  const copy = { title: (PRO_FEATURE_COPY[feature] || { title: 'Pro feature' }).title, desc: "Pro isn't available on this copy of Emergency Fund Aquarium. It's part of the hosted version at emergencyfundaquarium.com. A tank there starts fresh, nothing moves over from here." };
  const url = 'https://emergencyfundaquarium.com';
  const modal = document.getElementById('pro-required-modal');
  if (!modal) return;
  modal.querySelector('#pro-required-title').textContent = copy.title;
  modal.querySelector('#pro-required-desc').textContent = copy.desc;
  const cta = modal.querySelector('#pro-required-cta');
  cta.href = url;
  cta.textContent = 'Open emergencyfundaquarium.com';
  openOverlay('pro-required-modal');
}
function closeProRequired(fromHistory) { closeOverlay('pro-required-modal', fromHistory); }
document.addEventListener('click', (e) => {
  if (e.target?.dataset?.action === 'close-pro-modal') closeProRequired();
});

// ── Config ──────────────────────────────────────────────────────────────────
const API = location.origin;
// Signed in = currentUser is set. The session itself lives in the HttpOnly
// efa_session cookie, which page scripts can't read.
let currentUser = null;
let authMode = 'login';
let deposits = [];
let goals = [];
let trophyGoals = []; // graduated goals (is_active=0 with completed_at)
let activeGoal = null;
let depositsByGoal = {}; // cache: { goalId: [...deposits] }

// ── Crab Lines ──────────────────────────────────────────────────────────────
const CRAB_LINES = [
  "every dollar makes me<br>a little rounder.",
  "another deposit?<br>i'm swelling with pride.",
  "i've seen tides come and go.<br>savings stay.",
  "stop poking me<br>and go deposit something.",
  "my treasure map says<br>you need more savings.",
  "even pufferfish know:<br>always have a safety net.",
  "that deposit was<br>*chef's fin*.",
  "poke me again.<br>see what happens. (i puff.)",
  "the ocean provides,<br>but only if you save.",
  "i'm not just a pretty fish.<br>i'm your financial advisor.",
  "every dollar is a fish<br>in your aquarium.",
  "fun fact: i can't deflate<br>your savings. only you can.",
];
const CRAB_PROGRESS = [
  { min: 0, max: 0, line: "the tank is empty...<br>and i'm flat as a pancake." },
  { min: 1, max: 9, line: "a few bubbles.<br>but we need FISH." },
  { min: 10, max: 24, line: "the tide is rising!<br>i can feel myself puffing up." },
  { min: 25, max: 49, line: "coral is growing!<br>looking healthy in here." },
  { min: 50, max: 74, line: "half full!<br>i'm getting nicely round." },
  { min: 75, max: 99, line: "almost there!<br>my spikes are coming out." },
  { min: 100, max: 9999, line: "fully puffed!<br>the treasure is yours." },
];

// ── Tiers ───────────────────────────────────────────────────────────────────
const TIERS = [
  { name: 'Tide Pool', min: 0, color: '#9AA3B8' },
  { name: 'Shallows', min: 10, color: '#CFF25A' },
  { name: 'Coral Reef', min: 25, color: '#5CE1E6' },
  { name: 'Deep Blue', min: 50, color: '#B69CFF' },
  { name: 'The Abyss', min: 75, color: '#FFC857' },
  { name: 'Treasure Trove', min: 100, color: '#FF8A5C' },
];
function getTier(pct) { for (let i = TIERS.length - 1; i >= 0; i--) if (pct >= TIERS[i].min) return TIERS[i]; return TIERS[0]; }
const IRIS_COLORS = { 0: '#5CE1E6', 10: '#CFF25A', 25: '#B69CFF', 50: '#FFC857', 75: '#FF8A5C', 100: '#FF6B7A' };
function getIrisColor(pct) { let c = '#5CE1E6'; for (const [t, col] of Object.entries(IRIS_COLORS)) if (pct >= +t) c = col; return c; }

// ── Milestones ──────────────────────────────────────────────────────────────
const MILESTONES = [
  { key: 'first-drop', check: (p,d) => d.length >= 1, title: 'FIRST SPLASH!', msg: 'Your first deposit hits the water. The aquarium has begun.' },
  { key: 'ten-pct', check: p => p >= 10, title: 'THE TIDE IS RISING!', msg: '10% of your goal! Your first fish has arrived.' },
  { key: 'quarter', check: p => p >= 25, title: 'CORAL IS GROWING!', msg: 'Quarter way there! The reef is taking shape.' },
  { key: 'halfway', check: p => p >= 50, title: 'HALF FULL!', msg: 'The tank is half full. Look at this ecosystem!' },
  { key: 'three-quarter', check: p => p >= 75, title: 'ALMOST THERE!', msg: '75%! The deep blue is teeming with life.' },
  { key: 'goal-reached', check: p => p >= 100, title: 'TREASURE FOUND!', msg: 'YOU DID IT! Your emergency fund is fully stocked!' },
];

// ── Affiliate Nudges ────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------
// TIPS and NUDGES are deliberately SEPARATE. Help with the app
// is not a promo and must never take a promo's slot, or the promo surface just
// isn't one that day. TIPS teach the app. NUDGES sell something.
// ---------------------------------------------------------------------------
// App help. Rotates daily in #app-tip, above the promo card. No links, no
// labels, nothing to disclose. `act` runs a small in-app action.
const TIPS = [
  { text: 'Creatures arrive at percentages of your goal, not dollar amounts. A $1,000 goal and a $20,000 goal hit the same milestones.', cta: 'Open the Fish-Dex', act: 'go-dex' },
  { text: 'Log the small deposits too. $12 counts, and the tank does not care where the water came from.', cta: 'Add a deposit', act: 'go-deposit' },
  { text: 'No target in mind? $1,000 is the usual starter fund. It covers a car repair, a vet visit, or a deductible.', cta: 'See my progress', act: 'go-progress' },
  { text: 'Once a creature arrives it stays. The tank only ever gets fuller as long as you keep depositing.', cta: 'See who has arrived', act: 'go-dex' },
  { text: 'The Fish-Dex shows what is still out there, so you can see what the next milestone brings.', cta: 'Open the Fish-Dex', act: 'go-dex' },
  { text: 'Every deposit you have logged lives in History, and you can delete one if you logged it wrong.', cta: 'Open history', act: 'go-history' },
  { text: 'Everything in the app is explained in one place, with pictures.', cta: 'Open how it works', act: 'open-help' },
];
function renderAppTip(){
  const slot = document.getElementById('app-tip');
  if (!slot) return;
  const t = TIPS[Math.floor(Date.now()/86400000) % TIPS.length];
  slot.innerHTML = `<div class="tip-card help-tip"><div class="tip-text">${esc(t.text)}</div>`+
    `<button type="button" class="tip-cta" data-action="tip-act" data-tip-act="${esc(t.act)}">${esc(t.cta)} &rarr;</button></div>`;
}
// The CTA on an app-help tip. Never navigates off-site; that is what a promo does.
function runTipAction(act){
  switch(act){
    // The tip card lives on the Aquarium panel, so "Open the aquarium" is
    // usually clicked while already there and goTab() no-ops. Scroll to the
    // tank itself so the button always does something visible.
    case 'go-aquarium': { goTab('aquarium'); const t = document.getElementById('panel-aquarium'); if (t) t.scrollIntoView({ block: 'start', behavior: 'smooth' }); break; }
    case 'go-history':  goTab('deposits'); break;
    case 'go-progress': goTab('progress'); break;
    case 'go-dex':      goTab('dex'); break;
    case 'go-deposit':  goTab('deposit'); break;
    case 'open-help':   openHelp(); break;
  }
}

// Promos only: Jen Built It's own apps and posts, plus two affiliate links. Swap in your own.
const GENERAL_NUDGES = [
  { text: 'Want to save faster? Cancel unused subscriptions and redirect that money here.', link: 'https://subscriptiongraveyard.app', cta: 'Try Subscription Graveyard' },
  { text: 'Side hustle income is the fastest way to fill your fund. Track how close you are to covering your bills.', link: 'https://sidehustlegarden.com/', cta: 'Try Side Hustle Garden' },
  { text: 'Make saving a daily habit. Small consistent deposits add up faster than big sporadic ones.', link: 'https://dopaminedealerhabits.com/', cta: 'Build a saving habit' },
  { text: 'Car insurance and the Costco renewal shouldn\'t drain your fund. Jen Built It, the app\'s maker, made a free planner that turns once-a-year bills into one monthly number.', link: 'https://adminarcade.com/printable-annual-bills-planner/', cta: 'Get the bills planner' },
  { text: 'Jen Built It, the app\'s maker, made a free car log that shows what\'s due by mileage, so a skipped oil change doesn\'t turn into a fund withdrawal.', link: 'https://adminarcade.com/free-printable-car-maintenance-log/', cta: 'Get the car log' },
  { text: 'Track your energy and find when you\'re most productive. Earn more during your peak hours.', link: 'https://energybattery.app', cta: 'Try Energy Battery' },
  { text: 'Your habits determine your savings rate. Build daily financial habits that stick.', link: 'https://dopaminedealerhabits.com/', cta: 'Try Dopamine Dealer' },
  { text: 'If you create content, Logie connects you with brand samples and creator income that lands straight in your fund.', link: 'https://mylogie.com/signup?invitationCode=jensolt178', cta: 'Try Logie' },
  { text: 'Earn from Amazon as an influencer through Levanta. Direct deposits to your fund every month.', link: 'https://app.levanta.io/auth/refer/creator/6f09ce62-f84b-466a-8fde-d71742a1f425/sign-up', cta: 'Try Levanta' },
  { text: 'Jen Built It, the app\'s maker, made a free bill calendar that shows the week money gets tight, before you get there.', link: 'https://adminarcade.com/printable-bill-calendar/', cta: 'Get the bill calendar' },
  { text: 'Selling things to fill your fund? Run the real profit first, because sticker price lies.', link: 'https://seedingserendipity.com/reselling-profit-calculator/', cta: 'Read: reselling profit' },
  { text: 'Five dollars at a time feels like nothing until it is not. Here is how small daily actions stack up.', link: 'https://seedingserendipity.com/small-daily-actions-that-compound/', cta: 'Read: small actions compound' },
  { text: 'Cancel the link-in-bio subscription and send that money to the fund instead. Build a Bio, by the app\'s maker, has a free plan.', link: 'https://buildabio.com', cta: 'Try Build a Bio' },
  { text: 'Growing an audience is slow money, but it compounds like everything else here. Giveaway Widget, by the app\'s maker, embeds free.', link: 'https://giveawaywidget.com', cta: 'Try Giveaway Widget' },
  { text: 'Small deposits build the fund. A bigger paycheck fills it faster, and that starts with a resume that gets read.', link: 'https://resumeprune.com/', cta: 'Try Resume Prune' },
];
function isAff(url){if(!url)return false;const own=['dopaminedealerhabits.com','sidehustlegarden.com','subscriptiongraveyard.app','emergencyfundaquarium.com','energybattery.app','jen8ndirectory.com','resumeprune.com','jenbuiltit.com','jen8n.com','seedingserendipity.com','jentriedit.com','buildabio.com','giveawaywidget.com','porchpile.com','adminarcade.com','recipecolumncards.com','questmytasks.com'];return !own.some(d=>url.includes(d));}
const MILESTONE_NUDGES = {
  'first-drop': { text: 'Great start! Cancel unused subscriptions and redirect that money to your fund.', link: 'https://subscriptiongraveyard.app', cta: 'Try Subscription Graveyard' },
  'quarter': { text: '25% saved! Side hustle income can get you there even faster.', link: 'https://sidehustlegarden.com/', cta: 'Track side income' },
  'halfway': { text: 'Halfway there! Make saving a daily habit to keep the momentum going.', link: 'https://dopaminedealerhabits.com/', cta: 'Build a saving habit' },
  'goal-reached': { text: 'Fund complete! Ready to grow the next one? Side hustle income is the fastest way.', link: 'https://sidehustlegarden.com/', cta: 'Try Side Hustle Garden' },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n, currency = 'USD') { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n); }
// Parse 'YYYY-MM-DD' as LOCAL midnight. new Date('YYYY-MM-DD') parses as UTC
// midnight, which renders as the previous day for US users.
function parseLocalDate(s) { const [y, m, d] = String(s).slice(0, 10).split('-'); return new Date(+y, +m - 1, +d); }
// Today's date as 'YYYY-MM-DD' in the user's LOCAL timezone (toISOString() is
// UTC and rolls to tomorrow during US evenings).
function todayLocalISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fmtFull(n, currency = 'USD') { return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function toast(msg, ms = 3000) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
function syncStatus(state) {
  const dot = document.getElementById('sync-dot'), txt = document.getElementById('sync-txt');
  if (state === 'syncing') { dot.style.background = 'var(--gold)'; dot.style.boxShadow = '0 0 4px rgba(255,200,87,.4)'; txt.textContent = 'Syncing...'; }
  else if (state === 'error') { dot.style.background = 'var(--blood)'; dot.style.boxShadow = '0 0 4px rgba(255,107,122,.4)'; txt.textContent = 'Error'; }
  else { dot.style.background = 'var(--seafoam)'; dot.style.boxShadow = '0 0 4px var(--seafoam-glow)'; txt.textContent = 'Synced'; }
}
const NET_ERR = "Can't reach the server. Check your connection and try again.";
const SESSION_ENDED_MSG = 'Your session ended. Log in again.';
async function api(path, opts = {}) {
  syncStatus('syncing');
  try {
    let r;
    try {
      r = await fetch(API + path, { ...opts, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...opts.headers } });
    } catch (e) {
      // fetch() only rejects when nothing answered: offline, DNS, worker down.
      // "Failed to fetch" is browser-speak; say what it means and what to do.
      const err = new Error(NET_ERR); err.network = true; throw err;
    }
    const d = await r.json().catch(() => ({}));
    // Session-expiry handling: a 401 from a normal API call means the token is
    // dead (expired signature, or token_version bumped by a password change or
    // reset). End the session in place with one plain message. Auth endpoints
    // (login/signup/verify/resend/reset) also return 401 for bad credentials,
    // and so does the account-delete password check; those must fall through
    // to the error branch below so the form can show the server's message.
    if (r.status === 401 && !path.startsWith('/api/auth/')) { sessionEnded(); const err = new Error(SESSION_ENDED_MSG); err.sessionEnded = true; throw err; }
    if (r.status === 402) {
      const err = new Error(d.error || 'Pro required'); err.status = 402; err.data = d; throw err;
    }
    if (!r.ok) {
      const err = new Error(d.error || (r.status >= 500 ? 'Something went wrong on our end. Try again in a minute.' : 'Something went wrong. Try again.'));
      err.status = r.status;
      if (d.code) err.code = d.code;
      if (d.email) err.email = d.email;
      throw err;
    }
    syncStatus('ok');
    return d;
  } catch (e) { syncStatus('error'); throw e; }
}

// ── Pro Status Hydration ────────────────────────────────────────────────────
let isPro = false;
// Go Pro opens the note that Pro lives on the hosted version.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#unlock-pro-btn');
  if (b && !isPro) { e.preventDefault(); showProRequired(); }
});
async function hydrateProStatus() {
  try {
    const r = await fetch(API + '/api/pro-status', { credentials: 'same-origin' });
    const d = await r.json();
    isPro = !!d.is_pro;
    // Feedback button only when FEEDBACK_WEBHOOK_URL is set on the server.
    if (d.feedback_available === true) loadFeedbackWidget();
    const region = document.getElementById('pro-badge-region');
    const unlock = document.getElementById('unlock-pro-btn');
    if (isPro) {
      region.classList.add('show');
      unlock.style.display = 'none';
    } else {
      region.classList.remove('show');
      unlock.style.display = 'inline-block';
    }
    // Keep the biome picker's PRO stars honest for whichever path opens the
    // goal modal (first-run flow bypasses showAddGoalModal).
    syncBiomePickerStars();
  } catch (_) { /* non-fatal */ }
}

function showProUpgradeNudge(feature) {
  // Routed through the unified Pro modal (replaces the old browser confirm() dialog).
  showProRequired(feature || 'unlimited-goals');
}

// ── Progress calc ───────────────────────────────────────────────────────────
function getProgress() {
  if (!activeGoal) return { total: 0, target: 0, pct: 0, remaining: 0 };
  const total = deposits.reduce((s, d) => s + d.amount, 0);
  const target = activeGoal.target_amount;
  const pct = target > 0 ? Math.min((total / target) * 100, 999) : 0;
  return { total, target, pct: Math.round(pct * 10) / 10, remaining: Math.max(target - total, 0) };
}

// ── Auth ─────────────────────────────────────────────────────────────────────
// Pre-auth screen has two real steps: the login/signup tab and the 6-digit
// verify-code box (reached from signup, or an unverified login). Both are
// wired to the History API below (BROWSER BACK/FORWARD section) via the same
// choke-point pattern used for the main tabs: replaceState the landing view,
// pushState every real step, no-op when the target is already current, and
// skip the push entirely when restoring from a popstate event (`fromHistory`).
let currentAuthView = 'login'; // 'login' | 'signup' | 'verify'
function pushAuthView(view, replace) {
  const state = { authView: view, mode: authMode, email: pendingVerifyEmail };
  const url = location.pathname + location.search;
  if (replace) history.replaceState(state, '', url); else history.pushState(state, '', url);
}
function authTab(mode, fromHistory) {
  if (!fromHistory && mode === currentAuthView) return; // no-op: already on this tab
  showGuestBox(false);
  currentAuthView = mode;
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((t, i) => t.classList.toggle('active', (mode === 'login' ? i === 0 : i === 1)));
  document.getElementById('auth-submit-btn').textContent = mode === 'login' ? 'Log In' : 'Sign Up';
  document.getElementById('auth-err').style.display = 'none';
  document.getElementById('auth-suc').style.display = 'none';
  // Confirm-password only matters on sign up. Hide + clear it on login so a
  // stale value can't block a later sign up. 
  const pw2Wrap = document.getElementById('auth-pw2-wrap');
  if (pw2Wrap) pw2Wrap.style.display = mode === 'signup' ? 'block' : 'none';
  const pw2 = document.getElementById('auth-pw2');
  if (pw2 && mode === 'login') pw2.value = '';
  const pwHint = document.getElementById('auth-pw-hint');
  if (pwHint) pwHint.style.display = mode === 'signup' ? 'block' : 'none';
  const consent = document.getElementById('signup-consent');
  if (consent) consent.style.display = mode === 'signup' ? 'block' : 'none';
  document.getElementById('auth-pw').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  // Switching tabs returns to the credential form, hiding any open code box.
  document.getElementById('auth-form').style.display = '';
  document.getElementById('verify-code-form').style.display = 'none';
  document.getElementById('verify-code-resend').style.display = 'none';
  if (!fromHistory) pushAuthView(mode);
}
async function authSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('auth-submit-btn');
  const errEl = document.getElementById('auth-err');
  btn.disabled = true; errEl.style.display = 'none';
  try {
    const body = { email: document.getElementById('auth-email').value, password: document.getElementById('auth-pw').value };
    // Inline validation (form is novalidate so errors render in-page, not as
    // browser-native tooltips).
    if (!body.email.trim() || !body.password) {
      errEl.textContent = 'Please enter your email and password.'; errEl.style.display = 'block'; btn.disabled = false; return;
    }
    if (authMode === 'signup' && (body.password.length < 10 || body.password.length > 200)) {
      errEl.textContent = 'Password must be 10–200 characters.'; errEl.style.display = 'block'; btn.disabled = false; return;
    }
    if (authMode === 'signup' && body.password !== (document.getElementById('auth-pw2') || {}).value) {
      errEl.textContent = 'Passwords do not match. Please re-type them.'; errEl.style.display = 'block'; btn.disabled = false; return;
    }
    const d = await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify(body) });
    if (d.user) {
      currentUser = d.user;
      carryGuestOnEntry = true;
      enterApp(authMode === 'signup');
    } else if (d.awaiting_verification) {
      // Signup succeeded but needs email verification → show the code box.
      // email_sent is false only when Resend refused the message; say so
      // instead of promising an inbox that has nothing in it.
      showCodeEntry(d.email || body.email, false, d.email_sent === false, body.password);
    } else {
      // Signup on an email the server already knows (neutral response so
      // account existence never leaks). If that account is unverified, a fresh
      // code is re-sent in the background; either way, show the code box so nobody dead-ends.
      api('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email: body.email }) }).catch(() => {});
      showCodeEntry(body.email, false, false, body.password);
    }
  } catch (e) {
    if (e.code === 'email_not_verified') {
      // Existing unverified account → drop into the code box.
      showCodeEntry(e.email || document.getElementById('auth-email').value, false, false, document.getElementById('auth-pw').value);
    } else {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  }
  btn.disabled = false;
}
// Email that the pending 6-digit code was sent to.
let pendingVerifyEmail = '';
// Password typed at signup/login, sent along with the code (verify-code needs
// both). Memory only, never stored. Empty after a reload, so the code box then
// shows its own password field.
let pendingVerifyPw = '';
function setVerifyPwField() {
  const wrap = document.getElementById('verify-code-pw-wrap');
  if (wrap) wrap.style.display = pendingVerifyPw ? 'none' : 'block';
  const f = document.getElementById('verify-code-pw');
  if (f) f.value = '';
}
const MAIL_FAIL_MSG = "We couldn't send your code right now. Try Resend code in a minute.";
function showCodeEntry(email, fromHistory, mailFailed, password) {
  if (!fromHistory && currentAuthView === 'verify') return; // no-op: already showing the code box
  showGuestBox(false);
  currentAuthView = 'verify';
  const nextEmail = String(email || '').trim().toLowerCase();
  if (typeof password === 'string' && password) pendingVerifyPw = password;
  else if (nextEmail !== pendingVerifyEmail) pendingVerifyPw = '';
  pendingVerifyEmail = nextEmail;
  setVerifyPwField();
  document.getElementById('auth-form').style.display = 'none';
  document.getElementById('verify-code-form').style.display = 'block';
  document.getElementById('verify-code-resend').style.display = 'block';
  document.getElementById('verify-code-email').textContent = pendingVerifyEmail;
  const errEl = document.getElementById('auth-err');
  const s = document.getElementById('auth-suc');
  if (mailFailed) {
    errEl.textContent = MAIL_FAIL_MSG; errEl.style.display = 'block'; s.style.display = 'none';
  } else {
    errEl.style.display = 'none';
    s.textContent = 'Check your inbox for a 6-digit code.';
    s.style.display = 'block';
  }
  if (!fromHistory) pushAuthView('verify');
  const inp = document.getElementById('verify-code-input');
  inp.value = '';
  inp.focus();
}
async function verifyCodeSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('verify-code-btn');
  const errEl = document.getElementById('auth-err');
  btn.disabled = true; errEl.style.display = 'none';
  try {
    const code = document.getElementById('verify-code-input').value.replace(/\D/g, '');
    const pwField = document.getElementById('verify-code-pw');
    const password = pendingVerifyPw || (pwField ? pwField.value : '');
    if (!password) {
      errEl.textContent = 'Enter your password along with the code.'; errEl.style.display = 'block';
      if (pwField) pwField.focus();
      btn.disabled = false; return;
    }
    const d = await api('/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ email: pendingVerifyEmail, code, password }) });
    pendingVerifyPw = '';
    currentUser = d.user;
    carryGuestOnEntry = true;
    enterApp(true);
  } catch (err) {
    errEl.textContent = err.message || 'That code is invalid or expired.';
    errEl.style.display = 'block';
    // Wrong password: drop the remembered one and show the field to retype it.
    if (/password/i.test(err.message || '')) { pendingVerifyPw = ''; setVerifyPwField(); }
  }
  btn.disabled = false;
}
async function verifyCodeResend() {
  try {
    const d = await api('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email: pendingVerifyEmail }) });
    const s = document.getElementById('auth-suc');
    const el = document.getElementById('auth-err');
    if (d && d.email_sent === false) { el.textContent = MAIL_FAIL_MSG; el.style.display = 'block'; s.style.display = 'none'; return; }
    s.textContent = 'A new code has been sent. Check your inbox.';
    s.style.display = 'block';
    el.style.display = 'none';
  } catch (e) {
    const el = document.getElementById('auth-err');
    el.textContent = e.message;
    el.style.display = 'block';
  }
}
function forgotPw() {
  const email = document.getElementById('auth-email').value;
  if (!email) { const e = document.getElementById('auth-err'); e.textContent = 'Enter your email first'; e.style.display = 'block'; return; }
  api('/api/auth/reset-request', { method: 'POST', body: JSON.stringify({ email }) });
  const s = document.getElementById('auth-suc'); s.textContent = 'If that email exists, a reset link has been sent.'; s.style.display = 'block';
}
// Reset token comes from the PATH (/reset/<token>). The old ?reset=<token> form
// is still read so links already sitting in inboxes keep working, but it is not
// what we send any more — see the quoted-printable note in the worker.
function getResetToken(){
  const m = location.pathname.match(/^\/reset\/([A-Za-z0-9._-]{16,256})\/?$/);
  if (m) return m[1];
  return new URLSearchParams(location.search).get('reset');
}
async function confirmReset() {
  const pw = document.getElementById('reset-pw').value;
  const resetToken = getResetToken();
  try {
    const d = await api('/api/auth/reset-confirm', { method: 'POST', body: JSON.stringify({ token: resetToken, password: pw }) });
    currentUser = d.user;
    document.getElementById('reset-screen').style.display = 'none';
    enterApp(false);
  } catch (e) { const el = document.getElementById('reset-err'); el.textContent = e.message; el.style.display = 'block'; }
}
// location.reload() re-fetches the same URL rather than pushing a new history
// entry, so the top-of-stack entry left over from the session (a tab, a goal
// switch) stays in place across the reload. init()'s own landing replaceState
// (see BROWSER BACK/FORWARD section) collapses that leftover entry back to a
// clean auth landing the moment the reloaded page runs, so a post-logout Back
// press never targets DOM that no longer exists.
// The server clears the HttpOnly cookie (the page can't). keepalive lets it
// finish even if the user closes the tab right after. The reload waits for
// that answer (up to 3s): reloading first could race the boot /api/me call
// against the still-set cookie and land the user right back in the app.
function clearServerSession() {
  return fetch(API + '/api/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {});
}
function logout() {
  currentUser = null;
  try { localStorage.removeItem('efa_token'); } catch (e) {}
  // A tank built on the logged-out screen must not wait on this device for the
  // next person who logs in here. Also covers
  // account delete, which ends in logout().
  clearGuestGoal();
  Promise.race([clearServerSession(), new Promise(r => setTimeout(r, 3000))]).then(() => location.reload());
}
// A session that is no longer good (expired, or revoked by a password change or
// reset elsewhere) ends in place: every overlay closed, the login screen shown,
// one plain message. No reload, so the message survives and a stored token
// that the server already rejected is not replayed.
let sessionEnding = false;
function sessionEnded() {
  if (!currentUser || sessionEnding) return;
  sessionEnding = true;
  try { closeAllOverlays(); } catch { /* nothing open */ }
  currentUser = null;
  clearServerSession(); // drop the dead cookie so the next load doesn't send it
  try { localStorage.removeItem('efa_token'); } catch (e) {}
  const fbw = document.querySelector('.fbw-btn'); if (fbw) fbw.style.display = 'none';
  const fbo = document.querySelector('.fbw-overlay'); if (fbo) fbo.classList.remove('fbw-open');
  document.getElementById('app-outer').style.display = 'none';
  document.getElementById('auth-screen').style.display = '';
  showLoadBanner('');
  currentAuthView = 'login';
  authTab('login', true);
  pushAuthView('login', true);
  const el = document.getElementById('auth-err'); el.textContent = SESSION_ENDED_MSG; el.style.display = 'block';
  document.getElementById('auth-suc').style.display = 'none';
  sessionEnding = false;
}

// ── Enter App ───────────────────────────────────────────────────────────────
async function enterApp(isNewUser) {
  hideBootScreen();
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-outer').style.display = 'grid';
  // Landing tab is always Aquarium (static HTML default) — replaceState (not
  // pushState) so this doesn't consume a Back press; it also collapses
  // whatever pre-auth step entry (login/signup/verify) was on top, so a
  // just-logged-in user's Back doesn't land on a stale auth-flow screen.
  // A refresh must leave you on the tab you were looking at. Browsers keep
  // history.state across a reload of the same entry, so the pushState from the
  // last tab switch is still readable here — read it before defaulting.
  // Without this, refreshing anywhere but the first tab bounced the user back
  // to it.
  // A FRESH LOGIN has no `view` in state — the top entry is the auth step — so
  // it still lands on the default, and the replaceState below still collapses
  // that auth entry, which is what this block was always protecting.
  // goTab(x, true) is the existing choke point: it does the DOM work and skips
  // the push. currentTab is nulled first so its no-op guard can't swallow it.
  currentTab = null;
  goTab(BOOT_VIEW || 'aquarium', true);
  pushViewState(true);
  hydrateProStatus();
  await loadAppData(isNewUser);
}
// The first data load. When it fails for any reason other than the session
// ending, the shell is not left half-rendered with a red sync dot and nothing
// else: a banner says what happened and Retry runs this again.
async function loadAppData(isNewUser) {
  try {
    showLoadBanner('');
    const profile = await api('/api/profile');
    currentUser = profile;
    const acctEmail = document.getElementById('acct-email');
    if (acctEmail && currentUser && currentUser.email) acctEmail.textContent = currentUser.email;
    const goalsData = await api('/api/goals');
    goals = goalsData.filter(g => g.is_active === 1);
    trophyGoals = goalsData.filter(g => g.is_active === 0 && g.completed_at);
    // Load deposits for all active goals
    depositsByGoal = {};
    for (const g of goals) {
      depositsByGoal[g.id] = await api(`/api/deposits?goal_id=${g.id}`);
    }
    activeGoal = goals[0] || null;
    deposits = activeGoal ? (depositsByGoal[activeGoal.id] || []) : [];
    // A tank built on the logged-out screen moves in now (only after an
    // interactive sign-up, verify or log-in on this page, see carryGuestOnEntry).
    if (carryGuestOnEntry) { carryGuestOnEntry = false; await carryGuestGoal(); }
    await loadAchievements();
    await migrateLocalState();
    recordMetCreatures(getProgress()); // backfill accounts already mid-goal
    if (isNewUser) {
      // Blocking first-run gates: shown at the landing view, so no history entry
      // (Back from here leaves the app, same as the landing itself).
      localStorage.setItem('efa_onboard', '1');
      openOverlay('onboard-overlay', { gate: true });
    } else if (!goals.length) {
      prefillGoalFromGuest();
      openOverlay('goal-modal', { gate: true });
    } else {
      // Both landing gates are done for this user, so the tour has the screen
      // to itself rather than opening on top of one.
      setTimeout(maybeOfferTour, 450);
    }
    renderAll();
    scheduleBlink();
  } catch (e) {
    if (e.sessionEnded) return;
    console.error(e);
    showLoadBanner(e.network ? NET_ERR : "Your aquarium didn't load. " + e.message);
  }
}
function showLoadBanner(msg) {
  const b = document.getElementById('load-banner'), t = document.getElementById('load-banner-msg');
  if (!b || !t) return;
  t.textContent = msg; b.style.display = msg ? 'flex' : 'none';
}
// "Let's Go!" swaps one gate for the next for a goal-less account. Both are
// landing-level gates, so the stack is emptied and re-seeded rather than
// layered — otherwise Back out of the goal form would re-open onboarding.
function closeOnboard(fromHistory) {
  closeOverlay('onboard-overlay', fromHistory);
  if (!activeGoal && !overlayIsOpen('goal-modal')) { prefillGoalFromGuest(); openOverlay('goal-modal', { gate: true }); }
}
// If a built tank couldn't move in (connection dropped), the first-run goal
// form starts with what they already picked instead of blank.
function prefillGoalFromGuest() {
  const g = readGuestGoal();
  if (!g) return;
  document.getElementById('goal-name').value = g.name;
  document.getElementById('goal-amount').value = String(g.amount);
  document.getElementById('goal-biome').value = g.biome;
  document.querySelectorAll('#biome-picker .goal-chip').forEach(b => b.classList.toggle('active', b.dataset.biome === g.biome));
}
async function createGoal() {
  const name = document.getElementById('goal-name').value || 'Emergency Fund';
  const amount = parseFloat(document.getElementById('goal-amount').value);
  if (!amount || amount < 100) { toast('Enter a target amount (min $100)'); return; }
  try {
    const biome = document.getElementById('goal-biome').value || 'ocean';
    const g = await api('/api/goals', { method: 'POST', body: JSON.stringify({ name, target_amount: amount, biome }) });
    goals.push(g);
    depositsByGoal[g.id] = [];
    clearGuestGoal(); // a fund exists now, so a tank left over from the logged-out screen is moot
    // Consume, don't unwind: the fund now exists, so the goal-modal entry is
    // stale and Back must skip it. Runs BEFORE switchGoal so its replaceState
    // overwrites the overlay entry and switchGoal's push lands on a clean one.
    consumeOverlay('goal-modal');
    switchGoal(g.id);
    document.getElementById('goal-name').value = 'Emergency Fund';
    document.getElementById('goal-amount').value = '';
    renderAll();
    toast('New fund created! Log your first deposit.');
  } catch (e) {
    if (e.status === 402) { showProUpgradeNudge(e.data?.feature); return; }
    toast(e.message);
  }
}
// Graduation: close out a fully-stocked fund to the trophy shelf (frees the
// active-goal slot, which matters most on the free tier).
async function graduateGoal() {
  if (!activeGoal) return;
  const ok = await showConfirm({
    title: 'Graduate this fund?',
    message: `"${activeGoal.name}" moves to your trophy shelf. Its record stays forever, and the goal slot frees up for your next fund.`,
    confirmLabel: 'Graduate',
    danger: false,
  });
  if (!ok) return;
  try {
    const d = await api(`/api/goals/${activeGoal.id}/complete`, { method: 'POST' });
    if (d.goal) trophyGoals.unshift(d.goal);
    goals = goals.filter(g => g.id !== activeGoal.id);
    activeGoal = goals[0] || null;
    deposits = activeGoal ? (depositsByGoal[activeGoal.id] || []) : [];
    renderAll();
    fireConfetti(120);
    toast('Fund graduated to the trophy shelf');
    if (!goals.length) openOverlay('goal-modal', { gate: true });
  } catch (e) { toast(e.message); }
}

// Switching funds is a filter view (which tank's data is on screen) just
// like the main tabs — same choke-point pattern: no-op guard, push on real
// switches, skip the push when restoring from history (`fromHistory`).
function switchGoal(goalId, fromHistory) {
  if (!fromHistory && activeGoal && activeGoal.id === goalId) return; // no-op: already on this fund
  activeGoal = goals.find(g => g.id === goalId) || goals[0] || null;
  deposits = activeGoal ? (depositsByGoal[activeGoal.id] || []) : [];
  renderAll();
  if (!fromHistory) pushViewState();
}
function showAddGoalModal() {
  // Free tier: 1 goal max. Send free users with an existing goal to upgrade
  // BEFORE they fill out the form.
  if (!isPro && goals.length >= 1) {
    showProUpgradeNudge('unlimited-goals');
    return;
  }
  document.getElementById('goal-name').value = '';
  document.getElementById('goal-amount').value = '';
  document.getElementById('goal-biome').value = 'ocean';
  document.querySelectorAll('#biome-picker .goal-chip').forEach((b,i) => b.classList.toggle('active', i === 0));
  syncBiomePickerStars();
  // User-initiated ("+ new fund"), unlike the first-run gate — this one is a
  // real step in, so it takes a history entry and Back returns to the tank.
  openOverlay('goal-modal');
}
function closeGoalModal(fromHistory) { closeOverlay('goal-modal', fromHistory); }
// PRO stars on gated biome chips for free users; Pro accounts see plain chips.
function syncBiomePickerStars() {
  document.querySelectorAll('#biome-picker .goal-chip[data-pro]').forEach(b => {
    const star = b.querySelector('.pro-star');
    if (!isPro && !star) b.insertAdjacentHTML('afterbegin', '<svg class="pro-star" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2l2.9 6.2 6.8.8-5 4.6 1.3 6.7-6-3.3-6 3.3 1.3-6.7-5-4.6 6.8-.8Z" fill="#FFC857"/></svg>');
    if (isPro && star) star.remove();
  });
}
async function deleteGoal(goalId) {
  const g = goals.find(x => x.id === goalId);
  if (!g) return;
  const ok = await showConfirm({
    title: 'Drain this tank?',
    message: `"${g.name}" and all its deposits will be permanently deleted. This cannot be undone.`,
    confirmLabel: 'Delete fund',
  });
  if (!ok) return;
  try {
    await api(`/api/goals/${goalId}`, { method: 'DELETE' });
    goals = goals.filter(x => x.id !== goalId);
    delete depositsByGoal[goalId];
    localStorage.removeItem('efa_biome_' + goalId);
    localStorage.removeItem('efa_milestones_' + goalId);
    if (activeGoal && activeGoal.id === goalId) {
      activeGoal = goals[0] || null;
      deposits = activeGoal ? (depositsByGoal[activeGoal.id] || []) : [];
    }
    renderAll();
    toast('Fund deleted');
    if (!goals.length) openOverlay('goal-modal', { gate: true });
  } catch (e) { toast(e.message); }
}
function pickBiome(el, biome) {
  if (el.dataset.pro === '1' && !isPro) { showProRequired('pro-biomes'); return; }
  document.getElementById('goal-biome').value = biome;
  document.querySelectorAll('#biome-picker .goal-chip').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}
function getGoalBiome(goalId) {
  // Server is truth; localStorage remains the pre-migration fallback.
  const g = goals.find(x => x.id === goalId) || trophyGoals.find(x => x.id === goalId);
  if (g && g.biome) return g.biome;
  return localStorage.getItem('efa_biome_' + goalId) || 'ocean';
}

// ── Tabs ────────────────────────────────────────────────────────────────────
// Single choke point for main-tab navigation, wired to the History API (see
// BROWSER BACK/FORWARD below). `fromHistory` is set only by the popstate
// handler restoring a prior tab — it skips the pushState call so restoring
// never re-pushes (loop guard). enterApp() does a one-time replaceState for
// the landing tab; every other call here that changes the tab pushes a new
// entry, so the browser Back button steps through tabs the user actually
// visited instead of exiting the app.
const TAB_NAMES = ['aquarium', 'deposits', 'progress', 'dex', 'deposit'];
let currentTab = 'aquarium';
// Shared history-state helper for the tab + active-fund combo. Both goTab()
// and switchGoal() push/replace through here so one popped state always
// restores a full, consistent snapshot instead of the two dimensions
// drifting out of sync.
function pushViewState(replace) {
  const state = { view: currentTab, goalId: activeGoal ? activeGoal.id : null };
  const url = location.pathname + location.search;
  if (replace) history.replaceState(state, '', url); else history.pushState(state, '', url);
}
function goTab(name, fromHistory) {
  if (!TAB_NAMES.includes(name)) name = 'aquarium';
  if (!fromHistory && name === currentTab) return; // no-op: already on this tab, don't push a duplicate entry
  currentTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'deposit') { document.getElementById('dep-date').value = todayLocalISO(); }
  renderAll();
  if (!fromHistory) pushViewState();
}

// ── Render All ──────────────────────────────────────────────────────────────
// ── HELP PANEL ─────────────────────────────────────────────────────────────────
// Re-openable forever from the ? in the header. Goes through the overlay stack,
// so Back and Escape close it and a modal opened over it lands back on it.
function openHelp(){
  const m = document.getElementById('help-modal');
  if (!m) return;
  const body = m.querySelector('.help-body');
  if (body) body.scrollTop = 0;
  openOverlay('help-modal');
  const done = m.querySelector('.help-done');
  if (done) done.focus();
}
function closeHelp(fromHistory){ closeOverlay('help-modal', fromHistory); }

// ── GUIDED TOUR ────────────────────────────────────────────────────────────────
// Each stop highlights a real element with a ring and pins an explainer to the
// bottom. Registered as ONE layer on the overlay stack for the whole run, so
// Back ends the tour and leaves you on the app; per-stop entries would replay it.
const TOUR_STOPS = [
  { tab: null, sel: null, text: "new here? let me show you around the tank. five quick stops, or skip any time." },
  { tab: 'aquarium', sel: '#panel-aquarium', text: "this is your tank. the water level is how much of your goal you have saved, and everything living in it arrived because you put money in." },
  { tab: 'deposit', sel: '#panel-deposit', text: "this is the only thing you have to do. amount, date, and a note if you want. log the small ones too." },
  { tab: 'deposits', sel: '#panel-deposits', text: "history is every deposit you have logged. if you get one wrong you can delete it here." },
  { tab: 'progress', sel: '#panel-progress', text: "progress is how far along you are and how it has been going." },
  { tab: 'dex', sel: '#panel-dex', text: "the Fish-Dex is your collection: every creature you have met, and what is still out there waiting further up the tank. the ? up top reopens this any time." },
];
function tourSeen(){ try { return localStorage.getItem('efa_tour_done') === '1'; } catch { return false; } }
function tourMarkSeen(){ try { localStorage.setItem('efa_tour_done','1'); } catch {} }
let efaTourStep;
let efaTourOpener = null;
function startTour(){
  endTour();
  efaTourOpener = document.activeElement;
  efaTourStep = 0;
  openOverlay('tour-layer');
  renderTourStep();
}
function endTour(fromHistory){
  if (efaTourStep === undefined) return;
  if (!fromHistory && closeOverlay('tour-layer', false)) return; // popstate finishes it
  efaTourStep = undefined;
  tourMarkSeen();
  const b = document.getElementById('tourbox'); if (b) b.remove();
  const r = document.getElementById('tourring'); if (r) r.remove();
  const o = efaTourOpener; efaTourOpener = null;
  if (o && o !== document.body && o.isConnected && o.getClientRects().length) o.focus();
}
function renderTourStep(){
  const n = efaTourStep, stop = TOUR_STOPS[n];
  if (!stop) return endTour();
  const show = () => {
    const ob = document.getElementById('tourbox'); if (ob) ob.remove();
    const or = document.getElementById('tourring'); if (or) or.remove();
    if (stop.sel) {
      const el = document.querySelector(stop.sel);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const ring = document.createElement('div');
        ring.id = 'tourring';
        ring.style.cssText = `left:${r.left-6}px;top:${r.top-6}px;width:${r.width+12}px;height:${r.height+12}px;`;
        document.body.appendChild(ring);
      }
    }
    const last = n === TOUR_STOPS.length - 1;
    const box = document.createElement('div');
    box.id = 'tourbox';
    box.setAttribute('role','dialog');
    box.setAttribute('aria-label','App tour');
    box.innerHTML = `<p>${esc(stop.text)}</p><div class="tourrow">`+
      `<span class="tourcount">${n===0?'':`${n} of ${TOUR_STOPS.length-1}`}</span>`+
      `<button type="button" class="tourbtn ghost" id="tour-skip">${last?'Done':n===0?'No thanks':'Skip'}</button>`+
      (last?'':`<button type="button" class="tourbtn" id="tour-next">${n===0?'Show me':'Next'}</button>`)+
      `</div>`;
    document.body.appendChild(box);
    document.getElementById('tour-skip').onclick = () => endTour();
    const next = document.getElementById('tour-next');
    if (next) { next.onclick = () => { efaTourStep = n + 1; renderTourStep(); }; next.focus(); }
    else document.getElementById('tour-skip').focus();
  };
  // Switch tab first; the highlight target renders with the tab. fromHistory=true
  // so tab moves never stack entries on top of the tour's single overlay entry.
  if (stop.tab && currentTab !== stop.tab) { goTab(stop.tab, true); setTimeout(show, 70); }
  else show();
}
// Offered once, and only to an account that has not deposited anything yet.
function maybeOfferTour(){
  if (tourSeen()) return;
  if ((deposits || []).length) { tourMarkSeen(); return; }
  startTour();
}

function renderAll() {
  const p = getProgress();
  renderGoalSwitcher();
  renderTank(p);
  renderDeposits();
  renderProgress(p);
  renderAppTip();
  renderDailyTip();
  renderLedger(p);
  renderDex();
  renderTease(p);
  syncCrab(p);
  // Fund bar
  document.getElementById('fundFill').style.width = Math.min(p.pct, 100) + '%';
  document.getElementById('fundPct').textContent = activeGoal ? `${fmt(p.total)} / ${fmt(p.target)}` : 'No goal set';
  document.getElementById('tank-wrap').classList.toggle('goal-met', p.pct >= 100);
}
function renderGoalSwitcher() {
  const el = document.getElementById('goal-switcher');
  if (goals.length <= 1 && !activeGoal) { el.innerHTML = ''; return; }
  el.innerHTML = goals.map(g => {
    const deps = depositsByGoal[g.id] || [];
    const total = deps.reduce((s, d) => s + d.amount, 0);
    const pct = g.target_amount > 0 ? Math.round(total / g.target_amount * 100) : 0;
    const isActive = activeGoal && g.id === activeGoal.id;
    return `<button class="goal-chip${isActive ? ' active' : ''}" data-action="switchGoal" data-goal-id="${esc(g.id)}">${esc(g.name)}<span class="chip-pct">${pct}%</span></button>`;
  }).join('') + (() => {
    const title = 'Unlimited funds is a Pro feature.';
    return `<button class="goal-chip add-goal" data-action="showAddGoalModal" title="${title}"><svg class="pro-star" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2l2.9 6.2 6.8.8-5 4.6 1.3 6.7-6-3.3-6 3.3 1.3-6.7-5-4.6 6.8-.8Z" fill="#FFC857"/></svg>+ new fund</button>`;
  })();
}

// ── Tank Rendering — Biome-specific creature sets ───────────────────────────
// Shared creature renderers (reusable across biomes)
// TANK CREATURES, redrawn in Puff's style. Wired in by recolor-anglerfish.py (NEW_CREATURES).
// Drop-in for `const C` in public/app.js: same 49 keys, same (x,y) signature, each returns one <g>.
// Every creature is drawn around (0,0) and moved into place with an inner translate, so the outer
// <g> is free for the CSS swim/bob animation. Gradient ids get a per-call counter suffix so two
// copies of a creature on one page (tank + Fish-Dex + popup) never resolve to a hidden copy's defs.
let crN = 0;
const crQ = v => +(+v).toFixed(1);
const crI = k => 'cr-' + k + '-' + (++crN).toString(36);
// radial body gradient: light, mid, dark
const crR = (id, a, b, c) => `<radialGradient id="${id}" cx=".38" cy=".3" r=".8"><stop offset="0" stop-color="${a}"/><stop offset=".6" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient>`;
// sparkly eye: white, dark pupil, two sparkles
const crE = (x, y, r, w = '#fff') => { const l = r * .15; return `<circle cx="${crQ(x)}" cy="${crQ(y)}" r="${crQ(r)}" fill="${w}"/><circle cx="${crQ(x + l)}" cy="${crQ(y + r * .1)}" r="${crQ(r * .64)}" fill="#1B2440"/><circle cx="${crQ(x + l - r * .24)}" cy="${crQ(y - r * .2)}" r="${crQ(r * .26)}" fill="#fff"/><circle cx="${crQ(x + l + r * .22)}" cy="${crQ(y + r * .3)}" r="${crQ(r * .12)}" fill="#fff"/>`; };
const crB = (x, y, r = 2.4) => `<ellipse cx="${crQ(x)}" cy="${crQ(y)}" rx="${crQ(r)}" ry="${crQ(r * .6)}" fill="#FF8FA3" opacity=".65"/>`;
const crS = (x, y, w = 2.4, c = '#3A1E12') => `<path d="M${crQ(x - w)} ${crQ(y)}Q${crQ(x)} ${crQ(y + w)} ${crQ(x + w)} ${crQ(y)}" fill="none" stroke="${c}" stroke-width="1.3" stroke-linecap="round"/>`;
const crH = (x, y, rx, ry, o = .5) => `<ellipse cx="${crQ(x)}" cy="${crQ(y)}" rx="${crQ(rx)}" ry="${crQ(ry)}" fill="#fff" opacity="${o}" transform="rotate(-20 ${crQ(x)} ${crQ(y)})"/>`;
const crG = (x, y, a, s, f) => `<g${a ? ` style="animation:${a} ease-in-out infinite"` : ''}><g transform="translate(${x} ${y})${f ? ' scale(-1 1)' : ''}">${s}</g></g>`;
const crL = (id, c) => `<radialGradient id="${id}"><stop offset="0" stop-color="${c}" stop-opacity=".7"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;
const crA = (a, b, d) => `<animate attributeName="d" values="${a};${b};${a}" dur="${d}s" repeatCount="indefinite"/>`;
const crP = (d, c, w, e = '') => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${e}/>`;
const crW = (d, c, w, b, t) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round">${crA(d, b, t)}</path>`;
// standard right-facing fish. o: rx ry c[3] b(belly) t(tail) f(fins) p(pattern, clipped) pre(behind body) x(on top) d(0 = no dorsal) er st(outline)
const crF = (k, o) => {
  const g = crI(k), c = crI(k), { rx, ry } = o, t = o.t || o.c[1], f = o.f || t, q = crQ;
  return `<defs>${crR(g, ...o.c)}<clipPath id="${c}"><ellipse rx="${rx}" ry="${ry}"/></clipPath></defs>` +
    `<path d="M${q(-rx + 3)} 0L${q(-rx - ry * .95)} ${q(-ry * .85)}Q${q(-rx - ry * .5)} 0 ${q(-rx - ry * .95)} ${q(ry * .85)}Z" fill="${t}"/>` +
    (o.d === 0 ? '' : `<path d="M${q(-rx * .55)} ${q(-ry * .6)}Q${q(-rx * .15)} ${q(-ry * 1.55)} ${q(rx * .35)} ${q(-ry * .75)}Z" fill="${f}"/>`) + (o.pre || '') +
    `<ellipse rx="${rx}" ry="${ry}" fill="url(#${g})"${o.st ? ` stroke="${o.st}" stroke-width=".9"` : ''}/>` +
    `<g clip-path="url(#${c})"><ellipse cx="${q(rx * .1)}" cy="${q(ry * .66)}" rx="${q(rx * .85)}" ry="${q(ry * .5)}" fill="${o.b}" opacity=".9"/>${o.p || ''}</g>` +
    crH(-rx * .15, -ry * .55, rx * .3, ry * .17) +
    `<path d="M${q(-rx * .1)} ${q(ry * .2)}q${q(ry * .5)} ${q(-ry * .4)} ${q(ry * .75)} ${q(ry * .25)}q${q(-ry * .4)} 0 ${q(-ry * .75)} ${q(-ry * .25)}z" fill="${f}"/>` +
    crE(rx * .5, -ry * .18, o.er || ry * .38) + crB(rx * .48, ry * .34, ry * .2) + (o.m === 0 ? '' : crS(rx * .8, ry * .2, ry * .16)) + (o.x || '');
};
const crJ = (k, a, b, c, t, face) => { // jelly bell + tentacles
  const g = crI(k);
  return `<defs>${crR(g, a, b, c)}</defs>` +
    crW('M-12 5Q-15 19 -11 31', t, 2.4, 'M-12 5Q-8 19 -13 31', 2) + crW('M-4 7Q-6 22 -3 35', t, 2.4, 'M-4 7Q0 22 -5 35', 2.4) +
    crW('M4 7Q6 22 3 33', t, 2.4, 'M4 7Q0 22 5 33', 2.2) + crW('M12 5Q15 19 11 29', t, 2.4, 'M12 5Q8 19 13 29', 2.6) +
    `<path d="M-18 5Q-19 -16 0 -16Q19 -16 18 5Q15 9 11 6Q7 10 3.5 6Q0 10 -3.5 6Q-7 10 -11 6Q-15 9 -18 5Z" fill="url(#${g})" opacity=".95"/>` +
    crH(-8, -9, 5, 2.6, .6) + crE(-6, -3, 3.6) + crE(6, -3, 3.6) + crB(-10.5, 2, 2) + crB(10.5, 2, 2) + crS(0, 1, 2.2, face);
};

const C = {
  clownfish: (x, y) => crG(x, y, 'swim-lr 4s', crF('clownfish', { rx: 20, ry: 13.5, c: ['#FFC27A', '#FF8C2E', '#E2620C'], b: '#FFD9B0', t: '#FF8C2E',
    p: '<path d="M0 -16Q-3 0 0 16H6Q3 0 6 -16ZM-11 -16Q-7 0 -11 16H-5Q-1 0 -5 -16ZM-21 -12V12H-17Q-15 0 -17 -12Z" fill="#fff" stroke="#1B2440" stroke-width="1.2"/>' }), true),

  starfish: (x, y) => { const g = crI('starfish'); let d = ''; for (let i = 0; i < 5; i++) { const a = -1.5708 + i * 1.2566, b = a + .6283; d += `${i ? 'L' : 'M'}${crQ(15 * Math.cos(a))} ${crQ(15 * Math.sin(a) + 1)}L${crQ(6.5 * Math.cos(b))} ${crQ(6.5 * Math.sin(b) + 1)}`; }
    return crG(x, y, 0, `<defs>${crR(g, '#FFC7D1', '#FB7185', '#E24B67')}</defs><path d="${d}Z" fill="url(#${g})" stroke="#F0607B" stroke-width="4.5" stroke-linejoin="round"/>` +
      '<g fill="#FFE1E7" opacity=".8"><circle cx="0" cy="-9" r="1"/><circle cx="9" cy="-2" r="1"/><circle cx="-9" cy="-2" r="1"/><circle cx="6" cy="9" r="1"/><circle cx="-6" cy="9" r="1"/></g>' +
      crH(-3, -8, 2.6, 1.4, .6) + crE(-3.3, -.5, 2.7) + crE(3.3, -.5, 2.7) + crB(-5.8, 3.4, 1.5) + crB(5.8, 3.4, 1.5) + crS(0, 3.2, 1.7)); },

  seaweed: (x, y) => { const g = crI('seaweed'), f = (a, b, t) => `<path d="${a}" fill="url(#${g})">${crA(a, b, t)}</path>`;
    return crG(x, y, 0, `<defs><linearGradient id="${g}"><stop offset="0" stop-color="#7CF5BF"/><stop offset=".5" stop-color="#34D399"/><stop offset="1" stop-color="#15875A"/></linearGradient></defs>` +
      f('M5 20Q13 5 7 -8Q2 -20 10 -34Q14 -20 12 -8Q17 5 11 20Z', 'M5 20Q-1 5 7 -8Q12 -20 10 -34Q10 -20 12 -8Q3 5 11 20Z', 3.6) +
      f('M-4 20Q-12 0 -3.5 -20Q4 -40 0 -56Q9 -40 3.5 -20Q-4 0 4 20Z', 'M-4 20Q2 0 -3.5 -20Q-10 -40 0 -56Q-3 -40 3.5 -20Q10 0 4 20Z', 3) +
      crW('M0 18Q-8 0 0 -20Q7 -40 0 -52', '#C9FBE3', 1, 'M0 18Q6 0 0 -20Q-7 -40 0 -52', 3)); },

  bluetang: (x, y) => crG(x, y, 'swim-rl 5s', crF('bluetang', { rx: 22, ry: 16, c: ['#8FD3FF', '#2F86F0', '#1B4FB8'], b: '#A9DCFF', t: '#FFD23F', f: '#2563EB',
    p: '<path d="M8 -9C0 -15 -14 -13 -22 -4C-16 -5 -10 -3 -6 1C-12 2 -18 6 -22 10C-10 9 -2 3 1 -3C4 -6 6 -7 8 -9Z" fill="#132463"/>',
    x: '<path d="M-22 -6L-26 0L-22 6Z" fill="#FFD23F"/>' })),

  seahorse: (x, y) => { const g = crI('seahorse');
    return crG(x, y, 'bob 3.5s', `<defs>${crR(g, '#F1E4FF', '#C084FC', '#8B3FD9')}</defs>` +
      crP('M-1 10Q-4 22 3 25Q10 26 9 19Q8 14 3 16', '#A963F0', 5.5) +
      '<path d="M-8 -6Q-15 0 -9 6Z" fill="#E9D5FF" stroke="#B57BF5" stroke-width=".8"/>' +
      `<path d="M-3 -12Q9 -10 8 2Q7 12 -1 13Q-8 10 -8 0Q-8 -8 -3 -12Z" fill="url(#${g})"/>` +
      '<path d="M1 -5h5M1 -1h6M1 3h5.5M0 7h5" stroke="#F3E8FF" stroke-width="1" stroke-linecap="round" opacity=".8"/>' +
      `<ellipse cx="7" cy="-14" rx="7" ry="3.3" fill="url(#${g})"/><circle cx="0" cy="-17" r="8.5" fill="url(#${g})"/>` +
      '<path d="M-5 -24L-4 -29L-1.5 -26L0 -30.5L1.5 -26L4 -29L5 -24Z" fill="#FCD34D" stroke="#E0A10A" stroke-width=".7" stroke-linejoin="round"/>' +
      crH(-3.5, -21, 3, 1.6, .6) + crE(1.5, -17.5, 4.2) + crB(3, -11.5, 1.8) + crS(10.5, -13.5, 1.4)); },

  jellyfish: (x, y) => crG(x, y, 'bob 4s', crJ('jellyfish', '#FBF7FF', '#D9C6FF', '#A98BFA', '#C9B6FF', '#5B3A8A')),

  turtle: (x, y) => { const g = crI('turtle'), s = crI('turtle');
    return crG(x, y, 'swim-lr 7s', `<defs>${crR(g, '#A8F0C2', '#3FBF7F', '#1F8A57')}${crR(s, '#E3FAD6', '#A6E394', '#62B35A')}</defs>` +
      `<ellipse cx="-17" cy="8" rx="7" ry="3.5" fill="url(#${s})" transform="rotate(-30 -17 8)"/><path d="M-24 3L-29 5L-24 6Z" fill="#8FD67C"/>` +
      `<circle cx="26" cy="-3" r="8.5" fill="url(#${s})"/>` +
      '<ellipse cy="4" rx="25" ry="4.5" fill="#F3E6B8"/>' +
      `<path d="M-24 4Q-24 -20 0 -20Q24 -20 24 4Z" fill="url(#${g})"/>` +
      '<path d="M-6 -15H6L10 -7L6 0H-6L-10 -7ZM-19 -2L-15 -10L-12 -7L-14 0ZM19 -2L15 -10L12 -7L14 0Z" fill="#8CE3AF" opacity=".75"/>' +
      '<path d="M-24 4H24" stroke="#1F8A57" stroke-width="1.6" stroke-linecap="round"/>' +
      crH(-8, -15, 7, 2.6) + `<ellipse cx="14" cy="9" rx="8" ry="3.8" fill="url(#${s})" transform="rotate(28 14 9)"/>` +
      crE(27.5, -4.5, 3.8) + crB(28, 1, 1.8) + crS(31.5, .5, 1.6)); },

  pufferfish: (x, y) => { const g = crI('pufferfish'), w = crI('pufferfish'); let s = '';
    for (let i = 0; i < 12; i++) { const a = i / 12 * 6.283 + .2, c = Math.cos(a), n = Math.sin(a); if (c < -.75) continue;
      s += `<path d="M${crQ(15 * c - n * 2.6)} ${crQ(15 * n + c * 2.6)}L${crQ(22 * c)} ${crQ(22 * n)}L${crQ(15 * c + n * 2.6)} ${crQ(15 * n - c * 2.6)}Z" fill="#E7A21E"/>`; }
    return crG(x, y, 'bob 3s', `<defs>${crR(g, '#FFE38A', '#FFC43D', '#EE9F14')}${crR(w, '#FFFBEA', '#FFF3D1', '#FCE7B0')}</defs><path d="M-14 0L-26 -9Q-21 0 -26 9Z" fill="#F2A91F"/>${s}` +
      `<circle r="17" fill="url(#${g})"/><ellipse cx="1" cy="7.5" rx="12" ry="7.5" fill="url(#${w})"/>` +
      '<g fill="#D98C0F" opacity=".55"><circle cx="-6" cy="-10" r="1.6"/><circle cx="-1" cy="-12" r="1.6"/><circle cx="-10" cy="-5" r="1.6"/></g>' +
      crH(-7, -8, 4.5, 2.6) + '<path d="M-3 3q6 -4 8 2q-4 0 -8 -2z" fill="#F2A91F"/>' +
      crE(2.5, -3.5, 4.8) + crE(11, -4, 4.2) + crB(1, 3, 2.1) + crB(14, 2.5, 1.7) + crS(8, 4.5, 2.6)); },

  octopus: (x, y) => { const g = crI('octopus'), c = '#F27DB6';
    return crG(x, y, 'bob 3.8s', `<defs>${crR(g, '#FFD9EC', '#F9A8D4', '#E4629F')}</defs>` +
      crW('M-13 0Q-24 10 -20 19Q-16 24 -12 20', c, 5.5, 'M-13 0Q-20 10 -24 17Q-24 23 -19 21', 2) + crP('M-6 3Q-10 16 -6 22Q-3 25 -1 21', c, 5.5) +
      crP('M6 3Q10 16 6 22Q3 25 1 21', c, 5.5) + crW('M13 0Q24 10 20 19Q16 24 12 20', c, 5.5, 'M13 0Q20 10 24 17Q24 23 19 21', 2.3) +
      '<g fill="#FFE3F0"><circle cx="-19" cy="15" r="1"/><circle cx="-7" cy="15" r="1"/><circle cx="7" cy="15" r="1"/><circle cx="19" cy="15" r="1"/></g>' +
      `<ellipse cy="-8" rx="18" ry="16" fill="url(#${g})"/>` +
      '<g fill="#E86FAA" opacity=".45"><circle cx="-9" cy="-19" r="1.8"/><circle cx="8" cy="-20" r="1.4"/><circle cx="13" cy="-13" r="1.6"/></g>' +
      crH(-7, -17, 5, 2.8) + crE(-6.5, -8, 4.8) + crE(6.5, -8, 4.8) + crB(-11, -1, 2.2) + crB(11, -1, 2.2) + crS(0, -1.5, 3)); },

  manta: (x, y) => { const g = crI('manta');
    return crG(x, y, 'swim-lr 8s', `<defs>${crR(g, '#D4DDEE', '#8395B8', '#56668A')}</defs>` + crP('M0 8Q3 20 -3 30', '#56668A', 1.6) +
      `<path d="M0 -9C12 -9 30 -12 44 -2C34 1 22 8 10 11C5 13 -5 13 -10 11C-22 8 -34 1 -44 -2C-30 -12 -12 -9 0 -9Z" fill="url(#${g})"/>` +
      '<path d="M-30 2C-18 7 -8 9 0 9C8 9 18 7 30 2C20 9 8 12.5 0 12.5C-8 12.5 -20 9 -30 2Z" fill="#EEF2F8"/>' +
      '<path d="M-28 -6Q-18 -4 -12 -8M28 -6Q18 -4 12 -8" stroke="#E6ECF6" stroke-width="1.2" fill="none" stroke-linecap="round" opacity=".7"/>' +
      '<ellipse cx="-11" cy="7" rx="2.2" ry="4.2" fill="#56668A" transform="rotate(25 -11 7)"/><ellipse cx="11" cy="7" rx="2.2" ry="4.2" fill="#56668A" transform="rotate(-25 11 7)"/>' +
      crH(-6, -7, 6, 1.8) + crE(-6.5, -1, 3.6) + crE(6.5, -1, 3.6) + crB(-9, 4.5, 1.6) + crB(9, 4.5, 1.6) + crS(0, 4.5, 3.4, '#34405C')); },

  pearl: (x, y) => { const g = crI('pearl'), p = crI('pearl');
    return crG(x, y, 0, `<defs>${crR(g, '#FFD9BD', '#E7A77A', '#B9713F')}<radialGradient id="${p}" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#F5EEFF"/><stop offset="1" stop-color="#C9BCE6"/></radialGradient></defs>` +
      '<path d="M-16 -1Q-18 -18 0 -20Q18 -18 16 -1Z" fill="#C98758"/>' +
      '<path d="M0 -2L-12 -13M0 -2L-6 -18M0 -2V-19M0 -2L6 -18M0 -2L12 -13" stroke="#E9B48C" stroke-width="1.2" stroke-linecap="round"/>' +
      '<circle cy="-4" r="12" fill="#fff" opacity=".15"><animate attributeName="r" values="10;15;10" dur="2s" repeatCount="indefinite"/></circle>' +
      `<circle cy="-4" r="7.5" fill="url(#${p})"/>` + crH(-2.5, -7, 2.8, 1.6, .9) +
      `<path d="M-18 -1Q-16 10 0 10Q16 10 18 -1Z" fill="url(#${g})"/>` +
      '<path d="M-10 1Q-9 6 -8 9M-3 1V9.5M4 1V9.5M11 1Q10 6 9 9" stroke="#C98758" stroke-width="1" stroke-linecap="round" opacity=".6"/>'); },

  treasure: (x, y) => { const g = crI('treasure'), o = crI('treasure');
    return crG(x, y, 0, `<defs>${crR(g, '#EDB27A', '#B86B2A', '#7A3F14')}${crR(o, '#FFF6C4', '#FCD34D', '#D99A0B')}</defs>` +
      '<ellipse cy="-8" rx="16" ry="5" fill="#FDE68A" opacity=".35"><animate attributeName="opacity" values=".2;.5;.2" dur="2s" repeatCount="indefinite"/></ellipse>' +
      `<circle cx="-8" cy="-7" r="3.4" fill="url(#${o})"/><circle cx="-2" cy="-9" r="3.4" fill="url(#${o})"/><circle cx="5" cy="-8" r="3.4" fill="url(#${o})"/><circle cx="10" cy="-6" r="3" fill="url(#${o})"/>` +
      `<rect x="-17" y="-5" width="34" height="17" rx="3" fill="url(#${g})"/>` +
      `<path d="M-18 -5L-19 -14Q-18 -22 0 -22Q18 -22 19 -14L18 -5Q16 -12 0 -12Q-16 -12 -18 -5Z" fill="url(#${g})"/>` +
      `<path d="M-13 -21V-11.5M13 -21V-11.5M-13 -4V12M13 -4V12" stroke="url(#${o})" stroke-width="3.4"/><rect x="-17" y="-5" width="34" height="3" fill="url(#${o})"/>` +
      `<rect x="-3.6" y="-5" width="7.2" height="8.5" rx="2" fill="url(#${o})" stroke="#B7791F" stroke-width=".7"/><path d="M0 -2v3" stroke="#6B3A10" stroke-width="1.6" stroke-linecap="round"/>` +
      crH(-9, -18, 5, 1.4, .35) +
      '<path d="M15 -20l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill="#fff"><animate attributeName="opacity" values="0;1;0" dur="2s" repeatCount="indefinite"/></path>'); },

  parrotfish: (x, y) => crG(x, y, 'swim-lr 5s', crF('parrotfish', { rx: 22, ry: 15, c: ['#A5F7E8', '#2DD4BF', '#0E8F84'], b: '#D2FFF6', t: '#FB7185', f: '#F58FB8',
    p: '<path d="M-14 -8q3 3 6 0q3 3 6 0q3 3 6 0M-18 -1q3 3 6 0q3 3 6 0q3 3 6 0q3 3 6 0" stroke="#0E8F84" stroke-width="1" fill="none" opacity=".5"/><path d="M13 -6Q18 -2 16 5M-20 -10Q-18 0 -20 10" stroke="#FB7185" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
    x: '<path d="M19 -4Q26 0 19 6Q21 1 19 -4Z" fill="#F0FFFB" stroke="#9BE8DA" stroke-width=".6"/>', m: 0 }), true),

  tropicalplant: (x, y) => { const g = crI('tropicalplant'), l = crI('tropicalplant'), c = crI('tropicalplant'); let p = '';
    for (let i = 0; i < 6; i++) p += `<ellipse cy="-7.5" rx="4.6" ry="7.5" fill="url(#${g})" transform="rotate(${i * 60})"/>`;
    return crG(x, y, 0, `<defs>${crR(g, '#FFE1EA', '#FB7185', '#E0457A')}${crR(l, '#C8F7C5', '#4CC97A', '#248A4E')}${crR(c, '#FFF6C4', '#FCD34D', '#E09A0B')}</defs>` +
      crP('M0 15Q-1 8 0 0', '#2E9A58', 3) +
      `<ellipse cx="-7" cy="10" rx="7" ry="2.8" fill="url(#${l})" transform="rotate(-25 -7 10)"/><ellipse cx="7" cy="11" rx="7" ry="2.8" fill="url(#${l})" transform="rotate(25 7 11)"/>` +
      `<g transform="translate(0 -3)">${p}<circle r="3.8" fill="url(#${c})"/><circle cx="-1" cy="-1" r="1.2" fill="#fff" opacity=".7"/></g>`); },

  butterflyfish: (x, y) => crG(x, y, 'swim-rl 4s', crF('butterflyfish', { rx: 17, ry: 17, c: ['#FFF7BF', '#FFD43B', '#EFA80A'], b: '#FFF8D6', t: '#FFE066', f: '#FFC61A', er: 5,
    m: 0, pre: '<path d="M14 -3.5Q21 -1 21.5 1.5Q20.5 3.5 14 4.5Z" fill="#FFD43B"/><circle cx="20.6" cy="1.6" r=".8" fill="#3A1E12"/>',
    p: '<ellipse cx="8.5" cy="-6" rx="4.6" ry="10" fill="#1B2440" opacity=".85"/><path d="M-12 -12L-4 0L-12 12M-6 -15L2 0L-6 15" stroke="#EFA80A" stroke-width="1" fill="none" opacity=".6"/><circle cx="-8" cy="6" r="2.6" fill="#1B2440"/><circle cx="-8" cy="6" r="3.4" fill="none" stroke="#fff" stroke-width=".9"/>' })),

  seaanemone: (x, y) => { const g = crI('seaanemone'), t = crI('seaanemone'); let s = '';
    for (let i = -3; i <= 3; i++) { const b = i * 3.4, h = -24 + Math.abs(i) * 3, e = i * 5.5; const a = `M${crQ(b)} -1Q${crQ(e - 3)} ${crQ(h / 2)} ${crQ(e)} ${h}`, z = `M${crQ(b)} -1Q${crQ(e + 3)} ${crQ(h / 2)} ${crQ(e - 1.5)} ${h}`;
      s += `<path d="${a}" fill="none" stroke="url(#${t})" stroke-width="4" stroke-linecap="round">${crA(a, z, 2 + Math.abs(i) * .3)}</path>`; }
    return crG(x, y, 0, `<defs>${crR(g, '#FFD1E0', '#F472B6', '#C53B7F')}<linearGradient id="${t}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#EC4899"/><stop offset="1" stop-color="#FFD6E4"/></linearGradient></defs>` + s +
      `<path d="M-13 7Q-14 -3 -9 -4H9Q14 -3 13 7Q0 10 -13 7Z" fill="url(#${g})"/>` + crH(-6, -1, 3, 1.3, .5) +
      crE(-4, 1.5, 2.6) + crE(4, 1.5, 2.6) + crB(-7.5, 4.5, 1.4) + crB(7.5, 4.5, 1.4) + crS(0, 4.4, 1.6)); },

  bass: (x, y) => crG(x, y, 'swim-lr 5.5s', crF('bass', { rx: 24, ry: 14, c: ['#CFE6AE', '#7BA662', '#4A7038'], b: '#F1F5D8', t: '#6E9A56', f: '#5E8A4A', m: 0,
    pre: '<path d="M-13 -9L-10 -17L-7 -11L-4 -18L-1 -12L2 -17L4 -11Z" fill="#5E8A4A"/>',
    p: '<path d="M-24 0Q-18 -4 -12 0T0 0T12 -1" stroke="#3E5C30" stroke-width="3.2" fill="none" stroke-linecap="round" opacity=".5"/>',
    x: '<path d="M24 1Q19 6 13 4" stroke="#3E5C30" stroke-width="1.4" fill="none" stroke-linecap="round"/>' }), true),

  frog: (x, y) => { const g = crI('frog');
    return crG(x, y, 'bob 3s', `<defs>${crR(g, '#B8F7C0', '#4ADE80', '#1F9E4E')}</defs>` +
      `<ellipse cx="-13" cy="9" rx="7" ry="4.5" fill="url(#${g})"/><ellipse cx="13" cy="9" rx="7" ry="4.5" fill="url(#${g})"/>` +
      `<ellipse cy="2" rx="17" ry="13" fill="url(#${g})"/><ellipse cy="7" rx="10" ry="7" fill="#E3FCD9"/>` +
      `<circle cx="-7.5" cy="-9" r="7" fill="url(#${g})"/><circle cx="7.5" cy="-9" r="7" fill="url(#${g})"/>` +
      '<g fill="#1F9E4E" opacity=".45"><circle cx="-13" cy="0" r="1.6"/><circle cx="14" cy="-1" r="1.3"/><circle cx="-11" cy="5" r="1"/></g>' +
      '<ellipse cx="-6" cy="14" rx="4" ry="2.2" fill="#2FBF66"/><ellipse cx="6" cy="14" rx="4" ry="2.2" fill="#2FBF66"/>' +
      crH(-10, -13, 3, 1.6, .6) + crE(-7.5, -9, 5) + crE(7.5, -9, 5) + crB(-10.5, 1, 2.3) + crB(10.5, 1, 2.3) + crS(0, 0, 5, '#14532D')); },

  dragonfly: (x, y) => { const g = crI('dragonfly');
    return crG(x, y, 'bob 2s', `<defs>${crR(g, '#C6F1FF', '#22B8E8', '#0B6FA8')}</defs>` +
      '<g fill="#BDE9FF" fill-opacity=".6" stroke="#E6F7FF" stroke-width=".8"><ellipse cx="-10" cy="-7" rx="11" ry="3.6" transform="rotate(-12 -10 -7)"/><ellipse cx="10" cy="-7" rx="11" ry="3.6" transform="rotate(12 10 -7)"/><ellipse cx="-9" cy="-1" rx="9" ry="3" transform="rotate(14 -9 -1)"/><ellipse cx="9" cy="-1" rx="9" ry="3" transform="rotate(-14 9 -1)"/></g>' +
      `<ellipse cy="9" rx="2.8" ry="12" fill="url(#${g})"/><path d="M-2.6 4h5.2M-2.6 9h5.2M-2.4 14h4.8" stroke="#0B6FA8" stroke-width=".7" opacity=".6"/>` +
      `<ellipse cy="-5" rx="4" ry="5" fill="url(#${g})"/><circle cy="-12" r="5.5" fill="url(#${g})"/>` +
      crE(-3, -13, 3.1) + crE(3, -13, 3.1) + crB(-4, -9, 1.2) + crB(4, -9, 1.2) + crS(0, -9.5, 1.3, '#0B3B5C')); },

  lilypad: (x, y) => { const g = crI('lilypad');
    return crG(x, y, 0, `<defs>${crR(g, '#C2F7CF', '#4ADE80', '#1F9E54')}</defs>` +
      `<path d="M0 0L5 -7.8A22 8 0 1 1 -5 -7.8Z" fill="url(#${g})" stroke="#1F9E54" stroke-width=".8"/>` +
      '<path d="M0 0L-16 -4M0 0L-18 3M0 0L-6 7M0 0L8 7M0 0L18 3M0 0L16 -4" stroke="#BDF5CC" stroke-width=".9" opacity=".7"/>' +
      '<g transform="translate(8 -4)"><ellipse cx="-3.5" cy="-2" rx="2.4" ry="4.5" fill="#F9A8D4" transform="rotate(-30 -3.5 -2)"/><ellipse cx="3.5" cy="-2" rx="2.4" ry="4.5" fill="#F9A8D4" transform="rotate(30 3.5 -2)"/><ellipse cy="-3" rx="2.6" ry="5" fill="#FBCFE8"/><circle cy="0" r="1.8" fill="#FCD34D"/></g>'); },

  duck: (x, y) => { const g = crI('duck');
    return crG(x, y, 'swim-rl 6s', `<defs>${crR(g, '#FFF3B0', '#FFD43B', '#EFA20C')}</defs>` +
      `<path d="M-18 3Q-21 -9 -13 -6Q-6 -2 2 -2Q16 -3 16 6Q14 14 0 14Q-16 14 -18 3Z" fill="url(#${g})"/>` +
      '<path d="M-9 3Q0 -2 7 4Q0 10 -9 3Z" fill="#F7B91E"/>' +
      `<circle cx="8" cy="-10" r="9" fill="url(#${g})"/>` +
      '<path d="M15 -9Q23 -11 25 -6.5Q23 -3 15 -4Z" fill="#FF9A3D"/><path d="M16 -6.3Q20 -6 24 -6.5" stroke="#E0741C" stroke-width=".8" fill="none"/>' +
      crH(4, -15, 3.4, 1.8, .6) + crE(10, -12, 3.8) + crB(11.5, -6.5, 1.8)); },

  anglerfish: (x, y) => { const g = crI('anglerfish');
    const h = crI('anglerfish'); return crG(x, y, 'swim-lr 6s', `<defs>${crR(g, '#9AABD0', '#56668C', '#2E3A5A')}${crL(h, '#22D3EE')}</defs>` +
      '<path d="M-15 0L-28 -10Q-23 0 -28 10Z" fill="#4B5A80"/><path d="M-10 -14L-8 -21L-5 -15L-3 -21L0 -16Z" fill="#4B5A80"/>' +
      crP('M2 -17Q8 -32 20 -25', '#6B7CA3', 1.8) +
      `<circle cx="20" cy="-22" r="11" fill="url(#${h})"><animate attributeName="opacity" values="1;.4;1" dur="2s" repeatCount="indefinite"/></circle>` + '<circle cx="20" cy="-22" r="3.8" fill="#A5F3FC"/><circle cx="19" cy="-23" r="1.2" fill="#fff"/>' +
      `<circle r="18" fill="url(#${g})" stroke="#AFC0E2" stroke-width=".8"/><ellipse cx="0" cy="8" rx="13" ry="6.5" fill="#9DB0D6" opacity=".5"/>` +
      '<path d="M3 6Q13 5 18.5 -3Q19 11 7 12.5Q2 11 3 6Z" fill="#151A2C"/><path d="M6.5 6.2l1.4 3 1.5-3.3zM11 5.2l1.4 3 1.3-3.8zM14.8 3l1.2 2.8 1.2-3.8z" fill="#fff"/>' +
      crH(-6, -10, 5, 2.4, .35) + '<path d="M-6 2q5 -4 8 1q-4 0 -8 -1z" fill="#6B7CA3"/>' +
      crE(5, -5, 5.6) + crB(1, 3, 2), true); },

  biolumjelly: (x, y) => { const h = crI('biolumjelly'); return crG(x, y, 'bob 4.5s', `<defs>${crL(h, '#22D3EE')}</defs><circle cy="-2" r="26" fill="url(#${h})"><animate attributeName="opacity" values=".9;.35;.9" dur="2s" repeatCount="indefinite"/></circle>` +
    crJ('biolumjelly', '#F0FEFF', '#67E8F9', '#0E9BB8', '#67E8F9', '#0E4A5C') +
    '<g fill="#CFFAFE"><circle cx="-11" cy="16" r="1"/><circle cx="-3" cy="22" r="1"/><circle cx="4" cy="18" r="1"/><circle cx="12" cy="14" r="1"/></g>'); },

  giantsquid: (x, y) => { const g = crI('giantsquid'), c = '#8B5CF6';
    return crG(x, y, 'swim-rl 9s', `<defs>${crR(g, '#E3D6FF', '#8B5CF6', '#5B21B6')}</defs>` +
      '<path d="M-7 -26L-16 -17L-8 -16ZM7 -26L16 -17L8 -16Z" fill="#7C4AE8"/>' +
      crW('M-8 11Q-16 26 -11 38Q-9 41 -14 43', c, 3.4, 'M-8 11Q-10 26 -15 38Q-18 41 -12 43', 3) + crP('M-4 12Q-7 24 -4 33', c, 3.4) + crP('M0 12Q0 26 -1 35', c, 3.4) +
      crP('M4 12Q7 24 4 33', c, 3.4) + crW('M8 11Q16 26 11 38Q9 41 14 43', c, 3.4, 'M8 11Q10 26 15 38Q18 41 12 43', 3.4) +
      '<ellipse cx="-13.5" cy="42.5" rx="2.4" ry="3" fill="#7C4AE8"/><ellipse cx="13.5" cy="42.5" rx="2.4" ry="3" fill="#7C4AE8"/>' +
      `<path d="M0 -34Q14 -18 12 6Q10 14 0 14Q-10 14 -12 6Q-14 -18 0 -34Z" fill="url(#${g})"/>` +
      '<g fill="#6D28D9" opacity=".4"><circle cx="-4" cy="-18" r="1.5"/><circle cx="4" cy="-12" r="1.8"/><circle cx="-6" cy="-7" r="1.3"/><circle cx="3" cy="-24" r="1.1"/></g>' +
      crH(-4, -20, 2.6, 5, .45) + crE(-5, 3, 4.2) + crE(5, 3, 4.2) + crB(-8.5, 8.5, 1.6) + crB(8.5, 8.5, 1.6) + crS(0, 8.5, 1.8, '#3B0F7A')); },

  tubeworm: (x, y) => { const p = crI('tubeworm'), r = (cx, cy, s, a) => `<g transform="translate(${cx} ${cy}) scale(${s})">${a || ''}<path d="M-3.4 1Q-6 -7 -2.5 -13Q0 -16.5 2.5 -13Q6 -7 3.4 1Z" fill="url(#${p})"/><path d="M-1.4 -1Q-2.6 -6 -1.2 -11M1.4 -1Q2.6 -6 1.2 -11" stroke="#FFD0D0" stroke-width=".7" stroke-linecap="round" fill="none" opacity=".8"/></g>`;
    return crG(x, y, 0, `<defs>${crR(p, '#FFC2C2', '#EF4444', '#A51D1D')}</defs>` +
      crP('M-7 16Q-9 3 -5 -9M1 16Q3 3 1 -15M9 16Q11 6 8 -5', '#B3A794', 6.5) + crP('M-7 16Q-9 3 -5 -9M1 16Q3 3 1 -15M9 16Q11 6 8 -5', '#F6F1E6', 4.4) +
      '<path d="M-8.5 8h3M-.5 6h3M8 9h3M-7.5 0h3M.8 -4h3" stroke="#D8CFBE" stroke-width=".9"/>' +
      r(-5, -9, .9) + r(8, -5, .8) + r(1, -15, 1.1, '<circle cy="-2" r="7" fill="#EF4444" opacity=".2"><animate attributeName="r" values="6;9;6" dur="2.5s" repeatCount="indefinite"/></circle>')); },

  fancoral: (x, y) => { const d = 'M0 14V2M0 4Q-10 -4 -14 -22M0 2Q-2 -14 -4 -28M0 2Q4 -14 5 -29M0 4Q10 -6 15 -21M-7 -5Q-14 -9 -18 -14M-3 -14Q-8 -20 -9 -26M3 -14Q9 -20 11 -27M8 -6Q15 -8 19 -12';
    return crG(x, y, 0, '<path d="M0 12Q-21 -2 -18 -24Q-4 -34 12 -30Q22 -22 20 -10Q14 4 0 12Z" fill="#FB7185" opacity=".22"/>' +
      crP(d, '#E0457A', 3.6) + crP(d, '#FB8FA8', 1.8) +
      '<g fill="#FFD1DC"><circle cx="-14" cy="-22" r="2"/><circle cx="-4" cy="-28" r="2"/><circle cx="5" cy="-29" r="2"/><circle cx="15" cy="-21" r="2"/><circle cx="-18" cy="-14" r="1.7"/><circle cx="-9" cy="-26" r="1.7"/><circle cx="11" cy="-27" r="1.7"/><circle cx="19" cy="-12" r="1.7"/></g>'); },

  braincoral: (x, y) => { const g = crI('braincoral'), c = crI('braincoral'), d = 'M-18 8Q-19 -14 0 -14Q19 -14 18 8Z';
    return crG(x, y, 0, `<defs>${crR(g, '#FFEFA8', '#FBBF24', '#D48A0C')}<clipPath id="${c}"><path d="${d}"/></clipPath></defs>` +
      `<ellipse cy="8" rx="19" ry="3.2" fill="#B87408" opacity=".5"/><path d="${d}" fill="url(#${g})"/>` +
      `<g clip-path="url(#${c})" fill="none" stroke="#C9780A" stroke-width="1.4" stroke-linecap="round" opacity=".65"><path d="M-17 4q3 -6 6 0t6 0t6 0t6 0t6 0"/><path d="M-15 -3q3 -5 6 0t6 0t6 0t6 0"/><path d="M-9 -9q3 -4 6 0t6 0t6 0"/></g>` +
      crH(-7, -8, 5, 2.2, .45)); },

  angelfishroyal: (x, y) => { const g = crI('angelfishroyal'), b = crI('angelfishroyal');
    return crG(x, y, 'swim-lr 4.5s', `<defs>${crR(g, '#FFF6B0', '#FFD43B', '#F2A60C')}${crR(b, '#8FD3FF', '#2F86F0', '#1B4FB8')}</defs>` +
      `<path d="M5 -13Q-6 -30 -20 -28Q-12 -20 -9 -8Z" fill="url(#${b})"/><path d="M5 13Q-6 30 -20 28Q-12 20 -9 8Z" fill="url(#${b})"/>` +
      '<path d="M-13 0L-25 -9Q-21 0 -25 9Z" fill="#FFD43B" stroke="#2F86F0" stroke-width="1"/>' +
      `<path d="M16 0Q14 -17 -2 -19Q-16 -12 -16 0Q-16 12 -2 19Q14 17 16 0Z" fill="url(#${b})"/>` +
      `<path d="M13 0Q11 -13 -2 -15Q-12 -9 -12 0Q-12 9 -2 15Q11 13 13 0Z" fill="url(#${g})"/>` +
      '<circle cx="5" cy="-11" r="2.6" fill="#1D4ED8" stroke="#BFE6FF" stroke-width="1"/>' +
      crH(-5, -9, 4, 2, .55) + crE(8, -3.5, 4.3) + crB(8.5, 3.5, 1.8) + crS(12.5, 2.4, 1.6)); },

  mandarinfish: (x, y) => crG(x, y, 'swim-rl 4s', crF('mandarinfish', { rx: 19, ry: 12.5, c: ['#8FDCFF', '#0EA5E9', '#0567A6'], b: '#38BDF8', t: '#F97316', f: '#FB923C',
    p: '<g fill="none" stroke-linecap="round"><path d="M-17 -6q4 -5 8 0t8 0t8 0M-15 3q4 -5 8 0t8 0t8 0M-8 9q4 -4 8 0t8 0" stroke="#22D3EE" stroke-width="4"/><path d="M-17 -6q4 -5 8 0t8 0t8 0M-15 3q4 -5 8 0t8 0t8 0M-8 9q4 -4 8 0t8 0" stroke="#FB923C" stroke-width="2.2"/></g>' })),

  cleanershrimp: (x, y) => { const g = crI('cleanershrimp');
    return crG(x, y, 'bob 2.8s', `<defs>${crR(g, '#FFB3BF', '#F43F5E', '#BE123C')}</defs>` +
      crP('M17 -2Q25 -14 31 -12M17 -1Q27 -6 31 0', '#fff', 1.1) +
      '<path d="M-7 5l-2 5M-2 5l-1 5M3 4l0 5M8 3l1 5" stroke="#F43F5E" stroke-width="1.4" stroke-linecap="round"/>' +
      '<path d="M-13 5L-21 8L-19 12L-15 11L-12 8Z" fill="#F43F5E"/><path d="M-21 8L-19 12" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>' +
      crP('M-13 6Q-12 -4 -2 -4Q8 -4 12 0', `url(#${g})`, 9.5) + crP('M-14.5 3Q-13 -7.5 -2 -7.5Q8 -7.5 12.5 -3.5', '#fff', 2.4) +
      '<path d="M-7 -6v8M-1 -7v8M5 -6v8" stroke="#BE123C" stroke-width=".7" opacity=".5"/>' +
      `<ellipse cx="14" cy="0" rx="5.5" ry="4.8" fill="url(#${g})"/>` +
      crH(-4, -5, 3.2, 1.2, .5) + crE(14.5, -3.5, 3.5) + crB(15.5, 2, 1.3) + crS(18, 1.2, 1.1)); },

  iceberg: (x, y) => { const g = crI('iceberg');
    return crG(x, y, 0, `<defs>${crR(g, '#FFFFFF', '#E6F6FF', '#A7DAF7')}</defs>` +
      '<path d="M-20 8H20L15 16H-14Z" fill="#7DD3FC" opacity=".45"/>' +
      `<path d="M-20 8L-13 -12Q-11 -15 -8 -12L-3 -6L4 -18Q6 -21 9 -17L20 8Z" fill="url(#${g})" stroke="#CDEBFB" stroke-width=".8" stroke-linejoin="round"/>` +
      '<path d="M-13 -12L-3 -6L-7 8H-20Z" fill="#BAE6FD" opacity=".6"/><path d="M4 -18L9 -17L20 8H11Z" fill="#8FD0F4" opacity=".45"/>' +
      '<path d="M-20 8H20" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity=".8"/>' +
      '<path d="M-6 -12l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" fill="#fff"><animate attributeName="opacity" values="0;1;0" dur="2.6s" repeatCount="indefinite"/></path>'); },

  penguin: (x, y) => { const g = crI('penguin'), w = crI('penguin');
    return crG(x, y, 'bob 3.2s', `<defs>${crR(g, '#61749E', '#2B3654', '#141B2E')}${crR(w, '#FFFFFF', '#F3F6FB', '#D5DDEA')}</defs>` +
      `<ellipse cx="-13" cy="2" rx="4" ry="10" fill="url(#${g})" transform="rotate(20 -13 2)"/><ellipse cx="13" cy="2" rx="4" ry="10" fill="url(#${g})" transform="rotate(-20 13 2)"/>` +
      '<ellipse cx="-5" cy="18.5" rx="4.6" ry="2.4" fill="#FB923C"/><ellipse cx="5" cy="18.5" rx="4.6" ry="2.4" fill="#FB923C"/>' +
      `<ellipse rx="14" ry="19" fill="url(#${g})" stroke="#7385AE" stroke-width=".8"/>` +
      `<ellipse cy="5" rx="10" ry="13.5" fill="url(#${w})"/><circle cx="-4.5" cy="-8" r="5.4" fill="url(#${w})"/><circle cx="4.5" cy="-8" r="5.4" fill="url(#${w})"/>` +
      crH(-6, -15, 3.4, 1.6, .35) + crE(-4.5, -8, 3.5) + crE(4.5, -8, 3.5) + crB(-7.5, -2.5, 1.7) + crB(7.5, -2.5, 1.7) +
      '<path d="M-3 -4.5Q0 -5.5 3 -4.5L0 -.5Z" fill="#FB923C" stroke="#EA7A1F" stroke-width=".6" stroke-linejoin="round"/>'); },

  seal: (x, y) => { const g = crI('seal'), c = crI('seal'), d = 'M-26 2Q-22 -12 2 -11Q16 -12 24 -8Q30 4 18 10Q0 15 -18 9Q-26 7 -26 2Z';
    return crG(x, y, 'swim-lr 6s', `<defs>${crR(g, '#EEF2F7', '#AAB6C6', '#76849A')}<clipPath id="${c}"><path d="${d}"/></clipPath></defs>` +
      '<path d="M-24 2L-34 -6Q-30 2 -35 9Z" fill="#8D9AAE"/>' +
      `<path d="${d}" fill="url(#${g})"/><g clip-path="url(#${c})"><ellipse cx="2" cy="11" rx="20" ry="5" fill="#F4F7FA"/></g>` +
      `<circle cx="20" cy="-5" r="9.5" fill="url(#${g})"/>` +
      '<g fill="#7B889C" opacity=".5"><circle cx="-12" cy="-6" r="1.4"/><circle cx="-5" cy="-8" r="1.1"/><circle cx="3" cy="-6" r="1.3"/><circle cx="-16" cy="-1" r="1"/></g>' +
      '<ellipse cx="6" cy="9" rx="6" ry="2.8" fill="#8D9AAE" transform="rotate(25 6 9)"/>' +
      crH(-6, -8, 7, 2, .45) + crE(20.5, -7, 4) + '<ellipse cx="28" cy="-3" rx="1.9" ry="1.3" fill="#334155"/>' +
      '<path d="M27.5 -1.2l5.5 -1.2M27.5 0l5.5 1.6" stroke="#64748B" stroke-width=".6"/>' + crB(22, -1, 1.8) + crS(27, .8, 1.4)); },

  narwhal: (x, y) => crG(x, y, 'swim-rl 7s', crF('narwhal', { rx: 28, ry: 13, c: ['#E3E8FF', '#A5B4FC', '#6E7FD8'], b: '#EEF1FF', t: '#8C9BEA', f: '#8C9BEA', d: 0, er: 4,
    pre: '<path d="M25 -5L46 -11.5L26 -1Z" fill="#FFF6DB"/><path d="M31 -6l1 3M36 -7.6l1 3M41 -9l.8 2.6" stroke="#D9C38E" stroke-width=".9"/>',
    p: '<g fill="#7C8BE0" opacity=".45"><circle cx="-12" cy="-8" r="1.6"/><circle cx="-4" cy="-10" r="1.3"/><circle cx="-18" cy="-3" r="1.2"/><circle cx="3" cy="-8" r="1.1"/></g>' }), true),

  beluga: (x, y) => { const g = crI('beluga');
    return crG(x, y, 'swim-lr 6.5s', `<defs>${crR(g, '#FFFFFF', '#EEF4FA', '#B8C8DA')}</defs>` +
      '<path d="M-24 1Q-32 -9 -38 -7Q-33 -1 -34 1Q-33 3 -38 9Q-32 11 -24 1Z" fill="#D5E0EC" stroke="#A9BCD2" stroke-width=".8"/>' +
      `<path d="M-26 2Q-20 -12 6 -12Q15 -17 24 -11Q30 -5 27 3Q22 12 6 12Q-16 13 -26 2Z" fill="url(#${g})" stroke="#A9BCD2" stroke-width=".9"/>` +
      '<ellipse cx="4" cy="8" rx="6" ry="2.6" fill="#D5E0EC" transform="rotate(25 4 8)"/>' +
      crH(14, -12, 5, 2, .9) + crE(14, -4, 3.6) + crB(16, 2.5, 1.9) +
      '<path d="M18 2.5Q23 6.5 27.5 2" stroke="#6B7F99" stroke-width="1.3" fill="none" stroke-linecap="round"/>', true); },

  orca: (x, y) => { const g = crI('orca'), c = crI('orca');
    return crG(x, y, 'swim-rl 8s', `<defs>${crR(g, '#56699A', '#1E2842', '#0D1224')}<clipPath id="${c}"><ellipse rx="34" ry="15"/></clipPath></defs>` +
      `<path d="M-2 -12L1 -31Q7 -26 12 -12Z" fill="url(#${g})" stroke="#5A6E9E" stroke-width=".8"/>` +
      '<path d="M-32 0Q-40 -10 -47 -9Q-42 -2 -32 1Q-42 4 -47 10Q-40 11 -32 0Z" fill="#1E2842" stroke="#5A6E9E" stroke-width=".8"/>' +
      `<ellipse rx="34" ry="15" fill="url(#${g})" stroke="#5A6E9E" stroke-width=".8"/>` +
      `<g clip-path="url(#${c})"><path d="M36 2Q24 13 4 11Q-8 10 -16 16H40Z" fill="#fff"/><ellipse cx="-8" cy="-12" rx="9" ry="3.4" fill="#A4B1CA" opacity=".6"/></g>` +
      '<ellipse cx="17" cy="-6" rx="6.5" ry="3" fill="#fff" transform="rotate(-12 17 -6)"/>' +
      '<ellipse cx="6" cy="11" rx="7" ry="3" fill="#1E2842" transform="rotate(30 6 11)"/>' +
      crH(-2, -10, 7, 1.8, .3) + crE(27, -2, 3.3) + crB(27, 4, 1.7) + crS(31, 3, 1.4), true); },

  snowcrab: (x, y) => { const g = crI('snowcrab');
    return crG(x, y, 'bob 3.5s', `<defs>${crR(g, '#FFE8EC', '#FDA4AF', '#E86479')}</defs>` +
      crP('M-10 4Q-20 4 -24 12M-9 6Q-17 10 -19 16M10 4Q20 4 24 12M9 6Q17 10 19 16M-11 1Q-22 -2 -26 4M11 1Q22 -2 26 4', '#F07C90', 2.2) +
      crP('M-10 -2Q-15 -7 -16 -11M10 -2Q15 -7 16 -11', '#F07C90', 3) +
      `<ellipse cx="-17.6" cy="-14" rx="2" ry="4.2" fill="url(#${g})" transform="rotate(-18 -17.6 -14)"/><ellipse cx="-14.2" cy="-14.6" rx="2" ry="4.2" fill="url(#${g})" transform="rotate(18 -14.2 -14.6)"/>` +
      `<ellipse cx="14.2" cy="-14.6" rx="2" ry="4.2" fill="url(#${g})" transform="rotate(-18 14.2 -14.6)"/><ellipse cx="17.6" cy="-14" rx="2" ry="4.2" fill="url(#${g})" transform="rotate(18 17.6 -14)"/>` +
      crP('M-4 -7V-11M4 -7V-11', '#F07C90', 1.6) +
      `<ellipse rx="14" ry="10" fill="url(#${g})"/>` +
      '<g fill="#fff" opacity=".85"><circle cx="-8" cy="-5" r=".9"/><circle cx="9" cy="-6" r=".8"/><circle cx="-1" cy="-8" r=".7"/><circle cx="11" cy="2" r=".7"/></g>' +
      crH(-6, -5, 3.6, 1.6, .5) + crE(-4.5, -12, 3) + crE(4.5, -12, 3) + crB(-8, 1.5, 1.8) + crB(8, 1.5, 1.8) + crS(0, 1.5, 2.4)); },

  lionfish: (x, y) => crG(x, y, 'swim-lr 5s', crF('lionfish', { rx: 18, ry: 12, c: ['#FFD9D9', '#F87171', '#C93A3A'], b: '#FFE4E4', t: '#F87171', f: '#EF5050', d: 0,
    pre: '<path d="M-12 -8L-18 -26Q-4 -33 10 -27L15 -19L10 -8Z" fill="#FCA5A5" opacity=".4"/><g stroke-linecap="round"><path d="M-10 -8L-18 -26M-5 -10L-8 -29M0 -11L1 -30M5 -10L10 -27M9 -8L15 -19" stroke="#E23B3B" stroke-width="2"/><path d="M-10 -8L-18 -26M-5 -10L-8 -29M0 -11L1 -30M5 -10L10 -27M9 -8L15 -19" stroke="#fff" stroke-width="1.2" stroke-dasharray="2 2.5"/></g>',
    p: '<path d="M-13 -14q-3 14 0 28M-7 -14q-3 14 0 28M-1 -14q-3 14 0 28M5 -14q-3 14 0 28" stroke="#fff" stroke-width="2.4" fill="none" opacity=".8"/>',
    x: '<path d="M0 5L-16 20Q-6 27 7 22Z" fill="#FCA5A5" opacity=".45"/><path d="M0 5L-16 20M1 6L-9 24M2 6L0 24M3 6L7 22" stroke="#E23B3B" stroke-width="1.5" stroke-linecap="round"/><path d="M0 5L-16 20M1 6L-9 24M2 6L0 24M3 6L7 22" stroke="#fff" stroke-width=".9" stroke-dasharray="2 2.5"/>' })),

  hermitcrab: (x, y) => { const g = crI('hermitcrab'), o = crI('hermitcrab');
    return crG(x, y, 'bob 3.4s', `<defs>${crR(g, '#FFE0C2', '#E0A06C', '#A9612C')}${crR(o, '#FFD2AE', '#FB923C', '#D2601A')}</defs>` +
      '<path d="M-14 8l-3 4.5M-9 9l-1 4.5M-4 9l1 4.5" stroke="#E57A2E" stroke-width="2" stroke-linecap="round"/>' +
      `<circle cx="6" cy="-4" r="12" fill="url(#${g})"/><path d="M13 -13L17 -18L16 -10Z" fill="#C98758"/>` +
      '<path d="M6 -12a8 8 0 1 1 -7.5 5.5a5 5 0 1 1 5 5.3a2.4 2.4 0 1 1 3 -3" stroke="#9A5A28" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".7"/>' +
      crH(2, -11, 4, 2, .5) +
      `<ellipse cx="-8" cy="4" rx="8" ry="6" fill="url(#${o})"/><ellipse cx="-17" cy="5" rx="5.2" ry="4" fill="url(#${o})"/><path d="M-22 5h4" stroke="#D2601A" stroke-width=".9" stroke-linecap="round"/>` +
      crP('M-11 -1L-12 -6M-5 -1L-4 -6', '#E57A2E', 1.6) + crE(-12, -7.5, 2.9) + crE(-4, -7.5, 2.9) + crB(-12.5, 3.5, 1.4) + crS(-8, 3.5, 1.6)); },

  damselfish: (x, y) => crG(x, y, 'swim-rl 3.5s', crF('damselfish', { rx: 13, ry: 9.5, c: ['#9CCBFF', '#3B82F6', '#1E4FC7'], b: '#FDE047', t: '#FDE047', f: '#FACC15', er: 3.8,
    p: '<g fill="#C7E3FF"><circle cx="-6" cy="-4" r=".8"/><circle cx="-2" cy="-6" r=".7"/><circle cx="-9" cy="0" r=".7"/></g>' })),

  mahi: (x, y) => crG(x, y, 'swim-lr 4.2s', crF('mahi', { rx: 27, ry: 11, c: ['#FFF3A0', '#FACC15', '#C9A00A'], b: '#FFF7C2', t: '#FACC15', f: '#E6B80A', d: 0,
    pre: '<path d="M22 -8Q0 -19 -24 -6L-22 -3Q0 -12 22 -5Z" fill="#2DD4BF"/>',
    p: '<ellipse cx="0" cy="-10" rx="30" ry="7" fill="#22C1A3" opacity=".75"/><g fill="#1D8FE0" opacity=".7"><circle cx="-10" cy="-2" r="1"/><circle cx="-2" cy="0" r=".9"/><circle cx="6" cy="-2" r="1"/><circle cx="-16" cy="1" r=".8"/></g>' })),

  koi: (x, y) => crG(x, y, 'swim-rl 5s', crF('koi', { rx: 22, ry: 12, c: ['#FFFFFF', '#F5F7FA', '#CBD4E1'], b: '#fff', t: '#FFB27A', f: '#FFC49A', st: '#D3DBE6',
    pre: '<path d="M-20 0Q-32 -15 -40 -9Q-32 0 -40 9Q-32 15 -20 0Z" fill="#FFD3B0" opacity=".85"/>',
    p: '<ellipse cx="-6" cy="-5" rx="8" ry="6" fill="#FB923C"/><ellipse cx="-14" cy="3" rx="4" ry="3" fill="#F97316" opacity=".85"/><ellipse cx="13" cy="-9" rx="7" ry="4" fill="#EF4444" opacity=".85"/>',
    x: '<path d="M21 2q3 2 5 5" stroke="#E0A080" stroke-width=".8" fill="none" stroke-linecap="round"/>' })),

  catfish: (x, y) => crG(x, y, 'swim-lr 6s', crF('catfish', { rx: 24, ry: 11.5, c: ['#DDE2E9', '#8C96A5', '#5B6474'], b: '#EEF0F3', t: '#7C8594', f: '#6B7483', er: 3.8, m: 0,
    x: '<path d="M22 1Q30 -3 35 -1M22 3Q30 5 34 9M19 5Q23 10 25 13" stroke="#5B6474" stroke-width="1.2" fill="none" stroke-linecap="round"/><path d="M15 3.5Q19 6.5 23 3" stroke="#3E4553" stroke-width="1.3" fill="none" stroke-linecap="round"/>' })),

  snail: (x, y) => { const g = crI('snail'), s = crI('snail');
    return crG(x, y, 0, `<defs>${crR(g, '#EFFFC2', '#A3E635', '#6BA314')}${crR(s, '#FFEFA8', '#FBBF24', '#C98506')}</defs>` +
      crP('M-14 -4L-17 -12M-11 -4L-9 -13', '#8CCB26', 2.2) +
      `<path d="M-19 9Q-19 1 -12 -5Q-8 -6 -7 0L10 4Q16 6 14 10H-17Q-19 10 -19 9Z" fill="url(#${g})"/>` +
      `<circle cx="3" cy="-3" r="10" fill="url(#${s})"/><path d="M3 -11a7.5 7.5 0 1 1 -7 5a4.6 4.6 0 1 1 4.6 4.8a2 2 0 1 1 2.6 -2.6" stroke="#B45309" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".65"/>` +
      crH(-1, -9, 3.4, 1.8, .6) + crE(-17, -13, 2.8) + crE(-9, -14, 2.8) + crB(-15, 3, 1.5) + crS(-13, 3.8, 1.5)); },

  crawdad: (x, y) => { const g = crI('crawdad');
    return crG(x, y, 'bob 3.6s', `<defs>${crR(g, '#FFB0B0', '#EF4444', '#991B1B')}</defs>` +
      crP('M12 -4Q22 -18 30 -16M11 -3Q24 -10 31 -8', '#DC2626', 1) +
      '<path d="M-3 5l-2 5M1 6l-1 5M5 6l0 5" stroke="#B91C1C" stroke-width="1.4" stroke-linecap="round"/>' +
      crP('M9 -3Q16 -8 20 -9M9 3Q16 6 20 7', '#DC2626', 3) +
      `<ellipse cx="24" cy="-10" rx="5.8" ry="3.8" fill="url(#${g})" transform="rotate(-15 24 -10)"/><ellipse cx="24" cy="8" rx="5.2" ry="3.4" fill="url(#${g})" transform="rotate(15 24 8)"/>` +
      '<path d="M25 -10.5L30 -11M25 8.5L29.5 9.5" stroke="#7F1D1D" stroke-width="1" stroke-linecap="round"/>' +
      '<path d="M-17 1L-25 -4Q-24 1 -26 6Z" fill="#DC2626"/>' +
      `<ellipse cx="-10" cy="1" rx="8.5" ry="5" fill="url(#${g})"/><path d="M-14 -3.5v9M-10 -4v10M-6 -3.6v9" stroke="#991B1B" stroke-width=".8" opacity=".6"/>` +
      `<ellipse cx="2" rx="10" ry="6.5" fill="url(#${g})"/>` +
      crH(-1, -3.5, 4, 1.6, .5) + crE(9, -6.5, 2.8) + crE(4, -6.5, 2.6) + crB(6, 2, 1.5) + crS(10.5, 1.5, 1.4)); },

  dumbooctopus: (x, y) => { const g = crI('dumbooctopus');
    return crG(x, y, 'bob 3.2s', `<defs>${crR(g, '#FFE8F3', '#F9A8D4', '#E0659F')}</defs>` +
      '<ellipse cx="-14" cy="-13" rx="7" ry="4.5" fill="#F7B9D8" transform="rotate(-30 -14 -13)"/><ellipse cx="14" cy="-13" rx="7" ry="4.5" fill="#F7B9D8" transform="rotate(30 14 -13)"/>' +
      `<path d="M-13 1Q-16 12 -10 14Q-6 10 -4 13Q0 16 4 13Q6 10 10 14Q16 12 13 1Z" fill="url(#${g})"/>` +
      `<path d="M-15 -4Q-16 -20 0 -20Q16 -20 15 -4Q15 4 0 5Q-15 4 -15 -4Z" fill="url(#${g})"/>` +
      crH(-6, -15, 4, 2, .6) + crE(-5.5, -8.5, 3.9) + crE(5.5, -8.5, 3.9) + crB(-9.5, -2.5, 1.9) + crB(9.5, -2.5, 1.9) + crS(0, -3, 2, '#9D174D')); },

  viperfish: (x, y) => { const g = crI('viperfish');
    const h = crI('viperfish'); return crG(x, y, 'swim-rl 5.5s', `<defs>${crR(g, '#A3B6DB', '#4A5D87', '#26324F')}${crL(h, '#22D3EE')}</defs>` +
      '<path d="M-24 0L-33 -7Q-30 0 -33 7Z" fill="#4A5D87"/>' + crP('M-4 -7Q-2 -20 8 -18', '#6B7FA8', 1.5) +
      `<circle cx="9" cy="-18" r="8" fill="url(#${h})"><animate attributeName="opacity" values="1;.4;1" dur="2.2s" repeatCount="indefinite"/></circle>` + '<circle cx="9" cy="-18" r="2.2" fill="#A5F3FC"/>' +
      `<ellipse rx="26" ry="8" fill="url(#${g})" stroke="#AFC2E6" stroke-width=".7"/><circle cx="17" cy="-1" r="9" fill="url(#${g})" stroke="#AFC2E6" stroke-width=".7"/>` +
      '<g fill="#67E8F9"><circle cx="-18" cy="5" r=".9"/><circle cx="-12" cy="5.8" r=".9"/><circle cx="-6" cy="6.2" r=".9"/><circle cx="0" cy="6.2" r=".9"/><circle cx="6" cy="5.8" r=".9"/></g>' +
      '<path d="M17 4.5Q22 5 25.5 2" stroke="#151A2C" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M19 3.6l1.3 6.4 1.7-6.1zM23 2.8l1.1 5.4 1.4-5.6z" fill="#fff"/>' +
      crH(-8, -4, 8, 1.8, .3) + crE(17, -3.5, 4.4) + crB(14, 3.5, 1.6), true); },

  lanternfish: (x, y) => { const d = (cx, v) => `<circle cx="${cx}" cy="6" r="1.4" fill="#67E8F9"><animate attributeName="opacity" values="${v}" dur="1.8s" repeatCount="indefinite"/></circle>`;
    return crG(x, y, 'swim-lr 4.5s', crF('lanternfish', { rx: 15, ry: 9.5, c: ['#D3DCEE', '#7486A8', '#46557A'], b: '#DDE5F2', t: '#5E6F94', f: '#5E6F94', er: 4.4, st: '#AFC0E0',
      x: d(-8, '1;.4;1') + d(-3, '.4;1;.4') + d(2, '1;.4;1') + d(7, '.4;1;.4') })); },

  isopod: (x, y) => { const g = crI('isopod'), c = crI('isopod');
    return crG(x, y, 0, `<defs>${crR(g, '#EEF0F8', '#A7AFC7', '#6B7391')}<clipPath id="${c}"><ellipse rx="18" ry="10"/></clipPath></defs>` +
      crP('M19 -3Q24 -10 28 -9M19 -1Q26 -4 29 -1', '#8C94AE', 1.1) +
      '<path d="M-12 8l-1 4M-6 9v4M0 9v4M6 9l1 4M11 7l1.5 3.5" stroke="#7C849F" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M-17 2L-22 -1L-22 5ZM-17 3L-21 7L-17 7Z" fill="#8C94AE"/>' +
      `<ellipse rx="18" ry="10" fill="url(#${g})"/>` +
      `<g clip-path="url(#${c})" fill="none" stroke-linecap="round"><path d="M-12 -10q-2 10 0 20M-6 -10q-2 10 0 20M0 -10q-2 10 0 20M6 -10q-2 10 0 20" stroke="#6B7391" stroke-width="1.1" opacity=".6"/><path d="M-10.5 -8q-1 3 0 6M-4.5 -8q-1 3 0 6M1.5 -8q-1 3 0 6" stroke="#fff" stroke-width="1" opacity=".5"/></g>` +
      `<ellipse cx="15" cy="1" rx="6.5" ry="7" fill="url(#${g})"/>` +
      crE(16, -2, 3) + crB(17.5, 3, 1.4) + crS(20, 2.6, 1.2)); },
};


// ── Fish-Dex metadata — every renderer in C gets a name + story ───
const DEX = {
  clownfish: { name: 'Pip', story: 'first one in every new tank. claims he discovered it.' },
  starfish: { name: 'Stella', story: 'sits perfectly still. secretly counting your deposits.' },
  seaweed: { name: 'The Fronds', story: 'they wave at every deposit. very supportive.' },
  bluetang: { name: 'Indigo', story: 'swims laps to celebrate. loses count around forty.' },
  seahorse: { name: 'Sir Reginald', story: 'posture of royalty. savings habits of a legend.' },
  jellyfish: { name: 'Squish', story: 'drifts wherever the current goes. your fund should not.' },
  turtle: { name: 'Sheldon', story: 'slow and steady. has never missed a goal.' },
  pufferfish: { name: 'Kirby', story: 'inflates with pride every time the water rises.' },
  octopus: { name: 'Ollie', story: 'eight arms, all of them holding onto your savings.' },
  manta: { name: 'Glide', story: 'shows up when things get serious. no sudden moves.' },
  pearl: { name: 'The Pearl', story: 'patience made visible. it grew one layer at a time.' },
  treasure: { name: 'The Chest', story: 'the whole point. it was your fund all along.' },
  parrotfish: { name: 'Mango', story: 'colorful, loud, and extremely proud of your progress.' },
  tropicalplant: { name: 'The Bloom', story: 'adds a little color to every milestone.' },
  butterflyfish: { name: 'Flutter', story: 'cannot sit still after a deposit. fair enough.' },
  seaanemone: { name: 'Wiggles', story: 'a thousand tiny arms cheering in slow motion.' },
  bass: { name: 'Boris', story: 'a no-nonsense lake fish. respects a solid plan.' },
  frog: { name: 'Fernando', story: 'leaps in the moment the water is high enough.' },
  dragonfly: { name: 'Zip', story: 'checks on the pond daily. approves of your streak.' },
  lilypad: { name: 'The Pad', story: 'a resting spot for savers on their way up.' },
  duck: { name: 'Waddles', story: 'calm on the surface. paddling hard underneath. relatable.' },
  anglerfish: { name: 'Lumen', story: 'brings her own light to the darkest saving months.' },
  biolumjelly: { name: 'Glow', story: 'proof that small glows add up in deep water.' },
  giantsquid: { name: 'The Deep One', story: 'rarely seen. only surfaces for big savers.' },
  tubeworm: { name: 'The Vent Crew', story: 'thriving where nobody thought anything could.' },
  fancoral: { name: 'The Fan', story: 'grows a branch for every deposit it witnesses.' },
  braincoral: { name: 'The Brain', story: 'the reef accountant. remembers every cent.' },
  angelfishroyal: { name: 'Duchess', story: 'reef royalty. expects the fund fully stocked.' },
  mandarinfish: { name: 'Marlow', story: 'the best dressed fish in any tank. zero exceptions.' },
  cleanershrimp: { name: 'Scrub', story: 'keeps the reef tidy and the books cleaner.' },
  iceberg: { name: 'The Berg', story: 'ninety percent of it sits below the surface. like your discipline.' },
  penguin: { name: 'Pebble', story: 'brings a pebble for every milestone. it is a whole thing.' },
  seal: { name: 'Salvador', story: 'claps for every deposit. genuinely delighted.' },
  narwhal: { name: 'Pointe', story: 'the unicorn of the sea. believes in your goal.' },
  beluga: { name: 'Boo', story: 'sings a little louder every time the water rises.' },
  orca: { name: 'Admiral', story: 'only patrols the tanks of serious savers. you qualified.' },
  snowcrab: { name: 'Frosty', story: 'pinches pennies in sub-zero water. respect.' },
  lionfish: { name: 'Vesper', story: 'never underdressed. treats every milestone like a runway.' },
  hermitcrab: { name: 'Doug', story: 'upgrades his shell the way you grow your fund. gradually.' },
  damselfish: { name: 'Blue', story: 'small fish. big opinions about your savings rate.' },
  mahi: { name: 'Rey', story: 'fast, golden, always chasing the next milestone.' },
  koi: { name: 'Miso', story: 'legend says she brings luck. logged deposits help more.' },
  catfish: { name: 'Gus', story: 'bottom dweller, top supporter.' },
  snail: { name: 'Shelby', story: 'slow is fine. steady is the whole strategy.' },
  crawdad: { name: 'Pinchy', story: 'guards the lake floor and your spare change.' },
  dumbooctopus: { name: 'Dot', story: 'flaps her little fins for every single deposit.' },
  viperfish: { name: 'Fang', story: 'looks scary. mostly just proud of you.' },
  lanternfish: { name: 'Spark', story: 'carries a light so your savings never swim in the dark.' },
  isopod: { name: 'Rollie', story: 'armored, unbothered, quietly compounding.' },
};

const BIOMES = {
  ocean: {
    name: 'Ocean', water: 'rgba(14,165,233,', sand: '#E8D5B7', sandDark: '#D4C4A0',
    creatures: [
      {pct:5,x:50,y:260,fn:'seaweed'},{pct:5,x:350,y:255,fn:'seaweed'},
      {pct:10,x:80,y:160,fn:'clownfish'},{pct:15,x:310,y:275,fn:'starfish'},
      {pct:20,x:280,y:150,fn:'bluetang'},{pct:25,x:160,y:270,fn:'starfish'},
      {pct:30,x:350,y:190,fn:'seahorse'},{pct:35,x:100,y:120,fn:'jellyfish'},
      {pct:40,x:240,y:200,fn:'clownfish'},{pct:45,x:320,y:120,fn:'bluetang'},
      {pct:50,x:200,y:180,fn:'turtle'},{pct:55,x:60,y:270,fn:'pearl'},
      {pct:60,x:120,y:200,fn:'pufferfish'},{pct:65,x:300,y:260,fn:'seahorse'},
      {pct:70,x:170,y:110,fn:'jellyfish'},{pct:75,x:60,y:200,fn:'octopus'},
      {pct:80,x:340,y:140,fn:'bluetang'},{pct:85,x:200,y:80,fn:'manta'},
      {pct:90,x:340,y:270,fn:'pearl'},{pct:95,x:100,y:100,fn:'turtle'},
      {pct:100,x:200,y:268,fn:'treasure'},
    ]
  },
  tropical: {
    name: 'Tropical', water: 'rgba(45,212,191,', sand: '#F5E6C8', sandDark: '#E8D5B0',
    creatures: [
      {pct:5,x:50,y:270,fn:'seaanemone'},{pct:5,x:340,y:275,fn:'tropicalplant'},
      {pct:10,x:80,y:170,fn:'butterflyfish'},{pct:15,x:280,y:262,fn:'hermitcrab'},
      {pct:20,x:300,y:140,fn:'parrotfish'},{pct:25,x:160,y:210,fn:'damselfish'},
      {pct:30,x:350,y:180,fn:'lionfish'},{pct:35,x:100,y:130,fn:'butterflyfish'},
      {pct:40,x:200,y:262,fn:'hermitcrab'},{pct:45,x:240,y:120,fn:'damselfish'},
      {pct:50,x:200,y:170,fn:'parrotfish'},{pct:55,x:60,y:150,fn:'lionfish'},
      {pct:60,x:320,y:200,fn:'damselfish'},{pct:65,x:140,y:272,fn:'seaanemone'},
      {pct:70,x:100,y:190,fn:'mahi'},{pct:75,x:280,y:260,fn:'seaanemone'},
      {pct:80,x:60,y:200,fn:'parrotfish'},{pct:85,x:340,y:110,fn:'butterflyfish'},
      {pct:90,x:200,y:85,fn:'mahi'},{pct:95,x:300,y:270,fn:'tropicalplant'},
      {pct:100,x:200,y:268,fn:'treasure'},
    ]
  },
  lake: {
    name: 'Lake', water: 'rgba(74,222,128,', sand: '#8B9E7E', sandDark: '#6B7F5E',
    creatures: [
      {pct:5,x:350,y:260,fn:'seaweed'},{pct:5,x:120,y:80,fn:'lilypad'},
      {pct:10,x:90,y:160,fn:'bass'},{pct:15,x:300,y:90,fn:'dragonfly'},
      {pct:20,x:280,y:85,fn:'lilypad'},{pct:25,x:340,y:180,fn:'koi'},
      {pct:30,x:200,y:75,fn:'duck'},{pct:35,x:160,y:90,fn:'dragonfly'},
      {pct:40,x:320,y:150,fn:'frog'},{pct:45,x:80,y:262,fn:'crawdad'},
      {pct:50,x:60,y:220,fn:'catfish'},{pct:55,x:240,y:270,fn:'seaweed'},
      {pct:60,x:350,y:85,fn:'lilypad'},{pct:65,x:100,y:90,fn:'dragonfly'},
      {pct:70,x:200,y:200,fn:'bass'},{pct:75,x:300,y:270,fn:'frog'},
      {pct:80,x:50,y:80,fn:'duck'},{pct:85,x:260,y:130,fn:'dragonfly'},
      {pct:90,x:180,y:268,fn:'snail'},{pct:95,x:140,y:160,fn:'frog'},
      {pct:100,x:200,y:268,fn:'treasure'},
    ]
  },
  deep: {
    name: 'Deep Sea', water: 'rgba(99,102,241,', sand: '#1E293B', sandDark: '#0F172A',
    creatures: [
      {pct:5,x:60,y:270,fn:'tubeworm'},{pct:5,x:320,y:265,fn:'tubeworm'},
      {pct:10,x:100,y:180,fn:'biolumjelly'},{pct:15,x:300,y:160,fn:'anglerfish'},
      {pct:20,x:200,y:260,fn:'tubeworm'},{pct:25,x:340,y:150,fn:'lanternfish'},
      {pct:30,x:80,y:120,fn:'jellyfish'},{pct:35,x:250,y:200,fn:'dumbooctopus'},
      {pct:40,x:160,y:250,fn:'tubeworm'},{pct:45,x:60,y:160,fn:'viperfish'},
      {pct:50,x:280,y:100,fn:'giantsquid'},{pct:55,x:180,y:140,fn:'biolumjelly'},
      {pct:60,x:340,y:200,fn:'jellyfish'},{pct:65,x:100,y:268,fn:'isopod'},
      {pct:70,x:200,y:170,fn:'octopus'},{pct:75,x:300,y:250,fn:'anglerfish'},
      {pct:80,x:120,y:100,fn:'giantsquid'},{pct:85,x:200,y:80,fn:'manta'},
      {pct:90,x:340,y:270,fn:'pearl'},{pct:95,x:60,y:200,fn:'biolumjelly'},
      {pct:100,x:200,y:268,fn:'treasure'},
    ]
  },
  coralreef: {
    name: 'Coral Reef', water: 'rgba(251,113,133,', sand: '#FBE7E0', sandDark: '#F3CDC2',
    creatures: [
      {pct:5,x:60,y:268,fn:'fancoral'},{pct:5,x:340,y:272,fn:'braincoral'},
      {pct:10,x:90,y:160,fn:'clownfish'},{pct:15,x:290,y:262,fn:'cleanershrimp'},
      {pct:20,x:300,y:140,fn:'angelfishroyal'},{pct:25,x:170,y:270,fn:'seaanemone'},
      {pct:30,x:350,y:190,fn:'mandarinfish'},{pct:35,x:110,y:120,fn:'butterflyfish'},
      {pct:40,x:210,y:264,fn:'fancoral'},{pct:45,x:250,y:120,fn:'parrotfish'},
      {pct:50,x:200,y:175,fn:'turtle'},{pct:55,x:70,y:268,fn:'braincoral'},
      {pct:60,x:320,y:210,fn:'angelfishroyal'},{pct:65,x:140,y:258,fn:'starfish'},
      {pct:70,x:100,y:200,fn:'mandarinfish'},{pct:75,x:60,y:205,fn:'octopus'},
      {pct:80,x:280,y:265,fn:'cleanershrimp'},{pct:85,x:340,y:110,fn:'butterflyfish'},
      {pct:90,x:200,y:80,fn:'manta'},{pct:95,x:130,y:262,fn:'pearl'},
      {pct:100,x:200,y:268,fn:'treasure'},
    ]
  },
  arctic: {
    name: 'Arctic', water: 'rgba(125,211,252,', sand: '#E2E8F0', sandDark: '#CBD5E1',
    creatures: [
      {pct:5,x:60,y:268,fn:'iceberg'},{pct:5,x:330,y:270,fn:'iceberg'},
      {pct:10,x:100,y:170,fn:'bluetang'},{pct:15,x:300,y:262,fn:'snowcrab'},
      {pct:20,x:280,y:150,fn:'penguin'},{pct:25,x:160,y:265,fn:'snowcrab'},
      {pct:30,x:340,y:190,fn:'seal'},{pct:35,x:100,y:120,fn:'jellyfish'},
      {pct:40,x:230,y:200,fn:'penguin'},{pct:45,x:320,y:120,fn:'beluga'},
      {pct:50,x:190,y:170,fn:'seal'},{pct:55,x:70,y:262,fn:'pearl'},
      {pct:60,x:130,y:200,fn:'narwhal'},{pct:65,x:290,y:255,fn:'penguin'},
      {pct:70,x:170,y:115,fn:'biolumjelly'},{pct:75,x:60,y:190,fn:'narwhal'},
      {pct:80,x:330,y:150,fn:'beluga'},{pct:85,x:200,y:85,fn:'orca'},
      {pct:90,x:340,y:268,fn:'iceberg'},{pct:95,x:110,y:95,fn:'orca'},
      {pct:100,x:200,y:268,fn:'treasure'},
    ]
  },
};

function renderTank(p) {
  const svg = document.getElementById('tank-svg');
  const biome = activeGoal ? BIOMES[getGoalBiome(activeGoal.id)] || BIOMES.ocean : BIOMES.ocean;
  const goalMet = p.pct >= 100;
  const waterH = Math.min(p.pct, 100) / 100 * 240;
  const waterY = 290 - waterH;
  let html = '';

  // Defs
  if (goalMet) {
    html += `<defs>
      <linearGradient id="waterGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(245,158,11,.08)"/><stop offset="100%" stop-color="rgba(245,158,11,.22)"/></linearGradient>
      <linearGradient id="goldShimmer" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FDE68A" stop-opacity=".15"/><stop offset="50%" stop-color="#F59E0B" stop-opacity=".08"/><stop offset="100%" stop-color="#FDE68A" stop-opacity=".15"/></linearGradient>
      <radialGradient id="lightRay" cx="50%" cy="0%" r="80%"><stop offset="0%" stop-color="rgba(253,224,71,.2)"/><stop offset="100%" stop-color="rgba(253,224,71,0)"/></radialGradient>
    </defs>`;
  } else {
    html += `<defs><linearGradient id="waterGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${biome.water}.06)"/><stop offset="100%" stop-color="${biome.water}.18)"/></linearGradient></defs>`;
  }

  // Sand floor
  const sandColor = goalMet ? '#F5E6C8' : biome.sand;
  const sandDark = goalMet ? '#E8D5B0' : biome.sandDark;
  html += `<rect x="0" y="280" width="400" height="20" rx="0" fill="${sandColor}"/>`;
  html += `<ellipse cx="80" cy="285" rx="30" ry="4" fill="${sandDark}" opacity=".5"/>`;
  html += `<ellipse cx="300" cy="288" rx="25" ry="3" fill="${sandDark}" opacity=".5"/>`;

  // Gold coins scattered on sand (goal met)
  if (goalMet) {
    for (let i = 0; i < 8; i++) {
      const cx = 30 + Math.random() * 340, cy = 276 + Math.random() * 8;
      html += `<circle cx="${cx}" cy="${cy}" r="${2+Math.random()*2.5}" fill="#FDE68A" opacity="${.4+Math.random()*.3}"/>`;
    }
  }

  // Water
  if (waterH > 0) {
    html += `<rect x="0" y="${waterY}" width="400" height="${waterH + 10}" fill="url(#waterGrad)" rx="0"/>`;
    // Shimmer overlay for goal met
    if (goalMet) {
      html += `<rect x="0" y="${waterY}" width="400" height="${waterH + 10}" fill="url(#goldShimmer)"><animate attributeName="opacity" values=".3;.6;.3" dur="3s" repeatCount="indefinite"/></rect>`;
      // Light rays from top
      html += `<rect x="0" y="0" width="400" height="300" fill="url(#lightRay)"/>`;
      // Golden light beams
      html += `<polygon points="160,0 180,280 200,0" fill="rgba(253,224,71,.04)"><animate attributeName="opacity" values=".04;.08;.04" dur="4s" repeatCount="indefinite"/></polygon>`;
      html += `<polygon points="240,0 220,280 260,0" fill="rgba(253,224,71,.03)"><animate attributeName="opacity" values=".03;.07;.03" dur="3.5s" repeatCount="indefinite"/></polygon>`;
      html += `<polygon points="80,0 100,260 120,0" fill="rgba(253,224,71,.03)"/>`;
      html += `<polygon points="300,0 320,260 340,0" fill="rgba(253,224,71,.025)"/>`;
    }
    html += `<line x1="0" y1="${waterY}" x2="400" y2="${waterY}" stroke="${goalMet ? 'rgba(245,158,11,.3)' : biome.water+'.2)'}" stroke-width="2"><animate attributeName="y1" values="${waterY};${waterY-2};${waterY}" dur="2s" repeatCount="indefinite"/><animate attributeName="y2" values="${waterY};${waterY-2};${waterY}" dur="2s" repeatCount="indefinite"/></line>`;
  }

  // Bubbles (more when goal met)
  const bubbleCount = goalMet ? 12 : 5;
  const bubbleColor = goalMet ? 'rgba(253,224,71,' : biome.water;
  for (let i = 0; i < bubbleCount; i++) {
    const bx = 40 + Math.random() * 320, by = 260 - Math.random() * Math.max(waterH - 20, 10);
    const bs = 2 + Math.random() * (goalMet ? 6 : 4), bd = 2 + Math.random() * 3;
    html += `<circle cx="${bx}" cy="${by}" r="${bs}" fill="${bubbleColor}.15)"><animate attributeName="cy" values="${by};${by - 40}" dur="${bd}s" repeatCount="indefinite"/><animate attributeName="opacity" values=".3;0" dur="${bd}s" repeatCount="indefinite"/></circle>`;
  }

  // Sparkles floating (goal met only)
  if (goalMet) {
    for (let i = 0; i < 6; i++) {
      const sx = 40 + Math.random() * 320, sy = 40 + Math.random() * 200;
      const sd = 2 + Math.random() * 3;
      html += `<g transform="translate(${sx},${sy})"><line x1="-4" y1="0" x2="4" y2="0" stroke="#FDE68A" stroke-width="1.5" stroke-linecap="round"><animate attributeName="opacity" values="0;.6;0" dur="${sd}s" repeatCount="indefinite"/></line><line x1="0" y1="-4" x2="0" y2="4" stroke="#FDE68A" stroke-width="1.5" stroke-linecap="round"><animate attributeName="opacity" values="0;.6;0" dur="${sd}s" repeatCount="indefinite"/></line></g>`;
    }
  }

  // Creatures (wrapped for tap-to-inspect; names come from the fish-dex).
  // Fresh arrivals get a one-shot pop-in so the unlock reads as a moment.
  for (const c of biome.creatures) {
    if (p.pct >= c.pct && C[c.fn]) {
      const meta = DEX[c.fn];
      const pop = arrivalPopFns.includes(c.fn) ? ' demo-pop' : '';
      html += `<g class="tank-creature${pop}" data-creature="${c.fn}" tabindex="0" role="button" aria-label="${meta ? esc(meta.name) : c.fn}">${C[c.fn](c.x, c.y)}</g>`;
    }
  }
  arrivalPopFns = [];

  // Crown floating at top center (goal met)
  if (goalMet) {
    html += `<g transform="translate(200,30)">
      <animate attributeName="transform" values="translate(200,30);translate(200,24);translate(200,30)" dur="3s" repeatCount="indefinite"/>
      <path d="M-18 8L-14-6L-6 2L0-10L6 2L14-6L18 8Z" fill="#F59E0B"/>
      <path d="M-18 8L-14-6L-6 2L0-10L6 2L14-6L18 8Z" fill="#FDE68A" opacity=".5" transform="translate(0,-1)"/>
      <rect x="-18" y="8" width="36" height="6" rx="2" fill="#D97706"/>
      <circle cx="-8" cy="11" r="2" fill="#FDE68A" opacity=".6"/>
      <circle cx="0" cy="11" r="2" fill="#FDE68A" opacity=".6"/>
      <circle cx="8" cy="11" r="2" fill="#FDE68A" opacity=".6"/>
      <circle cx="0" cy="-6" r="4" fill="#FBBF24" opacity=".2"><animate attributeName="r" values="4;8;4" dur="2s" repeatCount="indefinite"/></circle>
    </g>`;
    // "GOAL COMPLETE" text
    html += `<text x="200" y="58" text-anchor="middle" font-family="Bricolage Grotesque,Figtree,sans-serif" font-size="14" fill="#F59E0B" opacity=".6" letter-spacing="2"><animate attributeName="opacity" values=".4;.7;.4" dur="3s" repeatCount="indefinite"/>GOAL COMPLETE</text>`;
  }

  // Glass reflections
  html += `<rect x="8" y="8" width="4" height="60" rx="2" fill="white" opacity=".15"/>`;
  html += `<rect x="16" y="12" width="3" height="40" rx="1.5" fill="white" opacity=".1"/>`;
  // Border — golden when goal met
  html += `<rect x="0" y="0" width="400" height="300" rx="16" fill="none" stroke="${goalMet ? 'rgba(245,158,11,.3)' : biome.water+'.12)'}" stroke-width="${goalMet ? 3 : 2}"/>`;
  // Biome label
  html += `<text x="390" y="18" text-anchor="end" font-family="Bricolage Grotesque,Figtree,sans-serif" font-size="11" fill="${goalMet ? 'rgba(245,158,11,.5)' : biome.water+'.35)'}" letter-spacing=".5">${biome.name}</text>`;
  svg.innerHTML = html;
}

// ── Demo Tank (logged-out preview) ──────────────────────────────────────────
// Draws the same tank the app renders after signup, using the shared C creature
// renderers and the BIOMES layouts so the preview matches the real product.
// It is the visitor's OWN tank: on the "build" step
// it previews their theme and target at 75% full, and on the "tank" step it
// starts empty at their real target, with one sample deposit to try.
// demo.sub is the caption under the bar, set by whichever guest step is showing.
const demo = { biome: 'ocean', pct: 75, goal: 1000, sub: '' };

function renderDemoTank(fromPct) {
  const targets = ['demo-tank-svg-desktop', 'demo-tank-svg-mobile']
    .map(id => document.getElementById(id)).filter(Boolean);
  if (!targets.length) return;
  const pct = demo.pct;
  const biome = BIOMES[demo.biome] || BIOMES.ocean;
  const waterH = pct / 100 * 240;
  const waterY = 290 - waterH;
  const animateRise = typeof fromPct === 'number' && fromPct < pct;
  const fromH = animateRise ? fromPct / 100 * 240 : waterH;
  const fromY = 290 - fromH;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  targets.forEach((svg, idx) => {
    const gradId = 'demoWaterGrad' + idx; // unique per svg so hidden duplicates never shadow the visible one
    let html = `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${biome.water}.06)"/><stop offset="100%" stop-color="${biome.water}.18)"/></linearGradient></defs>`;
    // Sand floor
    html += `<rect x="0" y="280" width="400" height="20" fill="${biome.sand}"/>`;
    html += `<ellipse cx="80" cy="285" rx="30" ry="4" fill="${biome.sandDark}" opacity=".5"/>`;
    html += `<ellipse cx="300" cy="288" rx="25" ry="3" fill="${biome.sandDark}" opacity=".5"/>`;
    // Water (one-shot rise animation when a sample deposit just landed)
    const riseAnim = animateRise
      ? `<animate attributeName="y" from="${fromY}" to="${waterY}" dur="0.8s" fill="freeze"/><animate attributeName="height" from="${fromH + 10}" to="${waterH + 10}" dur="0.8s" fill="freeze"/>`
      : '';
    html += `<rect x="0" y="${waterY}" width="400" height="${waterH + 10}" fill="url(#${gradId})">${riseAnim}</rect>`;
    html += `<line x1="0" y1="${waterY}" x2="400" y2="${waterY}" stroke="${biome.water}.2)" stroke-width="2"><animate attributeName="y1" values="${waterY};${waterY - 2};${waterY}" dur="2s" repeatCount="indefinite"/><animate attributeName="y2" values="${waterY};${waterY - 2};${waterY}" dur="2s" repeatCount="indefinite"/></line>`;
    // Bubbles (only once there is water to rise through)
    if (waterH > 20) {
      for (let i = 0; i < 5; i++) {
        const bx = 40 + Math.random() * 320, by = 260 - Math.random() * Math.max(waterH - 20, 10);
        const bs = 2 + Math.random() * 4, bd = 2 + Math.random() * 3;
        html += `<circle cx="${bx}" cy="${by}" r="${bs}" fill="${biome.water}.15)"><animate attributeName="cy" values="${by};${by - 40}" dur="${bd}s" repeatCount="indefinite"/><animate attributeName="opacity" values=".3;0" dur="${bd}s" repeatCount="indefinite"/></circle>`;
      }
    }
    // Creatures unlocked up to the demo percentage; freshly-unlocked ones pop in
    for (const c of biome.creatures) {
      if (pct >= c.pct && C[c.fn]) {
        const isNew = animateRise && c.pct > fromPct;
        html += isNew ? `<g class="demo-pop">${C[c.fn](c.x, c.y)}</g>` : C[c.fn](c.x, c.y);
      }
    }
    // Glass reflections + border
    html += `<rect x="8" y="8" width="4" height="60" rx="2" fill="white" opacity=".15"/>`;
    html += `<rect x="16" y="12" width="3" height="40" rx="1.5" fill="white" opacity=".1"/>`;
    html += `<rect x="0" y="0" width="400" height="300" rx="16" fill="none" stroke="${biome.water}.12)" stroke-width="2"/>`;
    // Freeze SMIL animations for reduced motion (CSS animations are frozen via media query)
    if (reduceMotion) html = html.replace(/<animate[^>]*\/>/g, '');
    svg.innerHTML = html;
    svg.setAttribute('aria-label', `Preview aquarium, ${biome.name} theme, ${pct} percent full`);
  });
  // Captions (desktop + mobile variants share classes)
  document.querySelectorAll('.demo-amt').forEach(el => { el.textContent = `${fmt(demo.goal * pct / 100)} of ${fmt(demo.goal)} saved`; });
  document.querySelectorAll('.demo-pct').forEach(el => { el.textContent = `${pct}%`; });
  document.querySelectorAll('.demo-bar-fill').forEach(el => { el.style.width = pct + '%'; });
  document.querySelectorAll('.demo-caption-sub').forEach(el => { el.textContent = demo.sub; });
}

// One sample deposit on the "tank" step: 0% -> 10% of THEIR target, the water
// rises and the first creatures pop in. Nothing is stored; it shows what a real
// logged deposit will do. One-shot: the button hides after.
const SAMPLE_PCT = 10;
function demoDeposit() {
  if (guestView !== 'tank' || demo.pct >= SAMPLE_PCT) return;
  const from = demo.pct;
  demo.pct = SAMPLE_PCT;
  demo.sub = `That's what a ${fmt(demo.goal * SAMPLE_PCT / 100)} deposit does to your tank. It was only a sample, so nothing's logged yet.`;
  renderDemoTank(from);
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) {
    const biome = BIOMES[demo.biome] || BIOMES.ocean;
    const c = biome.creatures.slice().reverse().find(k => k.pct > from && k.pct <= demo.pct);
    ['demo-tank-svg-desktop', 'demo-tank-svg-mobile'].forEach(id => {
      const svg = document.getElementById(id);
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return; // hidden variant (desktop vs mobile)
      const bx = r.left + ((c ? c.x : 200) / 400) * r.width;
      const by = r.top + ((c ? c.y : 150) / 300) * r.height;
      burst(bx, by, 10);
    });
  }
  setSampleBtn(false);
}
function setSampleBtn(on) { document.querySelectorAll('.demo-sample-btn').forEach(b => { b.hidden = !on; }); }

// ── Guest build ──────────────────────────────────────────
// A logged-out visitor builds their own tank (fund name, target, theme) before
// any sign-up form. It never touches the server while they're a guest: it sits
// in localStorage and goes through the normal authed POST /api/goals (same
// validation, same free-tier one-fund cap) right after they sign up, verify or
// log in. Everything read back out of storage is re-validated here, because
// anything on the device can edit it.
const GUEST_KEY = 'efa_guest_goal';
const GUEST_MAX_AGE_MS = 30 * 86400000;
const GUEST_BIOMES = ['ocean', 'tropical']; // the free themes: a guest is never Pro
const GUEST_NAME_MAX = 80;
const GUEST_AMOUNT_MIN = 100;
const GUEST_AMOUNT_MAX = 10000000; // the server's own ceiling
function cleanGuestName(v) {
  // eslint-disable-next-line no-control-regex
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, GUEST_NAME_MAX);
}
function readGuestGoal() {
  let g = null;
  try { g = JSON.parse(localStorage.getItem(GUEST_KEY) || 'null'); } catch { g = null; }
  if (!g) return null;
  const now = Date.now();
  const name = typeof g === 'object' ? cleanGuestName(g.name) : '';
  const ok = typeof g === 'object' && g.v === 1
    && typeof g.name === 'string' && name.length > 0
    && typeof g.amount === 'number' && Number.isFinite(g.amount) && g.amount >= GUEST_AMOUNT_MIN && g.amount <= GUEST_AMOUNT_MAX
    && GUEST_BIOMES.includes(g.biome)
    && typeof g.at === 'number' && now - g.at < GUEST_MAX_AGE_MS && g.at <= now + 60000;
  if (!ok) { clearGuestGoal(); return null; }
  return { v: 1, name, amount: Math.round(g.amount * 100) / 100, biome: g.biome, at: g.at };
}
function saveGuestGoal(g) { try { localStorage.setItem(GUEST_KEY, JSON.stringify(g)); } catch { /* private mode: the steps still work this visit */ } }
function clearGuestGoal() { try { localStorage.removeItem(GUEST_KEY); sessionStorage.removeItem(GUEST_DRAFT_KEY); } catch { /* nothing stored */ } }
// What they've typed on the build step but not built yet, kept for this tab
// only (sessionStorage), so leaving for the guide or a legal page and pressing
// Back doesn't wipe it. Re-checked on read like the stored goal.
const GUEST_DRAFT_KEY = 'efa_guest_draft';
function saveGuestDraft() {
  try {
    sessionStorage.setItem(GUEST_DRAFT_KEY, JSON.stringify({
      name: cleanGuestName(document.getElementById('guest-name').value),
      amount: String(document.getElementById('guest-amount').value || '').slice(0, 12),
      biome: GUEST_BIOMES.includes(guestBiome) ? guestBiome : 'ocean',
    }));
  } catch { /* private mode: nothing kept */ }
}
function readGuestDraft() {
  let d = null;
  try { d = JSON.parse(sessionStorage.getItem(GUEST_DRAFT_KEY) || 'null'); } catch { d = null; }
  if (!d || typeof d !== 'object') return null;
  const name = cleanGuestName(d.name);
  const amount = typeof d.amount === 'string' && /^\d{0,8}(\.\d{0,2})?$/.test(d.amount) ? d.amount : '';
  return { name: name || 'Emergency Fund', amount, biome: GUEST_BIOMES.includes(d.biome) ? d.biome : 'ocean' };
}

// Armed only by an interactive sign-up, verify or log-in on this page, never by
// a silent boot session, so a tank left behind on a shared
// device can't slip into whoever's account happens to be signed in next.
let carryGuestOnEntry = false;
async function carryGuestGoal() {
  const g = readGuestGoal();
  if (!g) return;
  // One fund per carry, and never a second one: free accounts hold one active
  // fund, and an account that already has one keeps it as it is.
  if (goals.length) {
    clearGuestGoal();
    toast(`Your account already has a fund, "${goals[0].name}", so the tank you just built wasn't added. Your existing fund is safe.`, 7000);
    return;
  }
  try {
    const made = await api('/api/goals', { method: 'POST', body: JSON.stringify({ name: g.name, target_amount: g.amount, biome: g.biome }) });
    clearGuestGoal();
    goals.push(made);
    depositsByGoal[made.id] = [];
    activeGoal = made;
    deposits = [];
    toast(`"${made.name}" is saved to your account. Log your first deposit when you're ready.`, 5000);
  } catch (e) {
    if (e.sessionEnded) throw e;
    if (e.status === 402) {
      // The free one-fund cap (a fund made in another tab in the meantime).
      clearGuestGoal();
      toast("Your account already has a fund, so the tank you just built wasn't added. Your existing fund is safe.", 7000);
    } else if (e.status >= 400 && e.status < 500 && e.status !== 429) {
      // The server said no to the data itself: drop it rather than retry forever.
      clearGuestGoal();
    } else {
      // Dropped connection, rate limit or 5xx: keep it. The goal form opens
      // pre-filled with it, and the next interactive sign-in tries again.
      toast("We couldn't save your tank just now. Your picks are filled in below.", 5000);
    }
  }
}

// Guest views ('build' -> 'tank'). Same history pattern as the auth steps:
// replaceState for the landing view, pushState per move in, popstate restores
// through showGuest(view, { fromHistory: true }).
let guestView = null;
let guestBiome = 'ocean';
function showGuestBox(on) {
  const g = document.getElementById('guest-box'), a = document.getElementById('auth-box');
  if (g) g.hidden = !on;
  if (a) a.hidden = on;
  const screen = document.getElementById('auth-screen');
  if (screen) screen.dataset.mode = on ? 'guest' : 'auth';
  if (on) return;
  guestView = null;
  // On the log-in / sign-up card: say a built tank is waiting, or offer to build one.
  const pending = readGuestGoal();
  const note = document.getElementById('guest-carry-note');
  if (note) {
    note.hidden = !pending;
    note.textContent = pending ? `Your tank "${pending.name}" (${fmt(pending.amount)} goal) is saved on this device. It moves into your account when you sign up or log in.` : '';
  }
  const link = document.getElementById('guest-try-link');
  if (link) link.hidden = !!pending;
}
function showGuest(view, opts = {}) {
  const { replace = false, fromHistory = false } = opts;
  if (view !== 'build' && view !== 'tank') view = 'build';
  if (view === 'tank' && !readGuestGoal()) view = 'build';
  if (!fromHistory && !replace && view === guestView) return; // no-op: already here
  showGuestBox(true);
  currentAuthView = null; // off the auth card, so a later authTab() always takes its own entry
  guestView = view;
  document.getElementById('guest-build').hidden = view !== 'build';
  document.getElementById('guest-tank').hidden = view !== 'tank';
  if (view === 'build') renderGuestBuild(); else renderGuestTank();
  if (!fromHistory) {
    const st = { guestView: view }, url = location.pathname + location.search;
    if (replace) history.replaceState(st, '', url); else history.pushState(st, '', url);
  }
}
function renderGuestBuild() {
  // Coming back to edit: start from what they built last time. If they never
  // pressed Build, start from what they had typed in this tab.
  const g = readGuestGoal() || readGuestDraft();
  if (g) {
    document.getElementById('guest-name').value = g.name;
    document.getElementById('guest-amount').value = g.amount === '' ? '' : String(g.amount);
    guestBiome = g.biome;
  }
  document.getElementById('guest-err').style.display = 'none';
  syncGuestChips();
  previewGuestBuild();
}
function syncGuestChips() {
  document.querySelectorAll('[data-action="guestBiome"]').forEach(b => {
    const on = b.dataset.biome === guestBiome;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
function pickGuestBiome(biome) {
  if (!GUEST_BIOMES.includes(biome)) return;
  guestBiome = biome;
  syncGuestChips();
  previewGuestBuild();
  saveGuestDraft();
}
// Live preview while they type: their theme and target, shown 75% full.
function previewGuestBuild() {
  const amt = parseFloat(document.getElementById('guest-amount').value);
  demo.biome = guestBiome;
  demo.goal = Number.isFinite(amt) && amt >= GUEST_AMOUNT_MIN && amt <= GUEST_AMOUNT_MAX ? amt : 1000;
  demo.pct = 75;
  demo.sub = `A preview of your ${(BIOMES[guestBiome] || BIOMES.ocean).name} tank at 75%. Every deposit you log raises the water and brings in a new creature.`;
  setSampleBtn(false);
  renderDemoTank();
}
function guestBuildSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('guest-err');
  const name = cleanGuestName(document.getElementById('guest-name').value) || 'Emergency Fund';
  const raw = document.getElementById('guest-amount').value;
  const amount = Math.round(parseFloat(raw) * 100) / 100;
  let msg = '';
  if (!raw || !Number.isFinite(amount)) msg = 'Enter a target amount, at least $100.';
  else if (amount < GUEST_AMOUNT_MIN) msg = 'Make the target at least $100.';
  else if (amount > GUEST_AMOUNT_MAX) msg = 'Keep the target under $10,000,000.';
  if (msg) {
    errEl.textContent = msg; errEl.style.display = 'block';
    document.getElementById('guest-amount').focus();
    return;
  }
  errEl.style.display = 'none';
  saveGuestGoal({ v: 1, name, amount, biome: GUEST_BIOMES.includes(guestBiome) ? guestBiome : 'ocean', at: Date.now() });
  showGuest('tank');
}
function renderGuestTank() {
  const g = readGuestGoal();
  if (!g) return;
  document.getElementById('guest-tank-title').textContent = `"${g.name}" is ready`;
  demo.biome = g.biome;
  demo.goal = g.amount;
  demo.pct = 0;
  demo.sub = `Your ${(BIOMES[g.biome] || BIOMES.ocean).name} tank starts empty. The first creatures move in at 5% of your goal.`;
  setSampleBtn(true);
  renderDemoTank();
}
// Out of the guest flow into the auth card (a pushed step, so Back returns here).
function leaveGuestTo(mode) {
  currentAuthView = null;
  authTab(mode === 'signup' ? 'signup' : 'login');
  if (mode === 'signup') {
    const em = document.getElementById('auth-email');
    if (em) { em.scrollIntoView({ behavior: 'smooth', block: 'center' }); em.focus({ preventScroll: true }); }
  }
}
// Landing on the auth card itself (replaceState, so Back still leaves the site).
function landAuth(mode) {
  currentAuthView = null;
  authTab(mode, true);
  pushAuthView(mode, true);
}

// ── Deposits Rendering ──────────────────────────────────────────────────────
function renderDeposits() {
  const el = document.getElementById('deposits-list');
  // The empty state hands over the way out instead of just naming it.
  if (!deposits.length) { el.innerHTML = '<div class="empty-state">no deposits yet.<br>drop one in!<br><button type="button" class="btn btn-seafoam empty-cta" data-action="firstDeposit">Log your first deposit</button></div>'; return; }
  el.innerHTML = deposits.map(d => `
    <div class="dep-card">
      <div class="dep-amount">${fmtFull(d.amount)}</div>
      <div class="dep-date">${parseLocalDate(d.deposit_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      ${d.note ? `<div class="dep-note">${esc(d.note)}</div>` : ''}
      <div class="dep-actions">
        <button class="btn btn-danger btn-sm" data-action="deleteDeposit" data-deposit-id="${esc(d.id)}">Delete</button>
      </div>
    </div>
  `).join('');
}

// Read-only ledger for the >=1440 data column. Renders unconditionally — the
// column is display:none below that breakpoint, so there is no width probe to
// keep in sync with the CSS.
function renderLedger(p) {
  const stats = document.getElementById('ledger-stats');
  const list = document.getElementById('ledger-list');
  if (!stats || !list) return;
  if (!activeGoal) {
    stats.innerHTML = '<div class="ledger-stat">No fund yet</div>';
    list.innerHTML = '<div class="empty-state">nothing logged yet.</div>';
    return;
  }
  const rows = [
    ['Saved', fmt(p.total)],
    ['Target', fmt(p.target)],
    ['Left to go', fmt(p.remaining)],
    ['Deposits', String(deposits.length)],
  ];
  stats.innerHTML = rows.map(([k, v]) => `<div class="ledger-stat"><span>${k}</span><strong>${v}</strong></div>`).join('');
  if (!deposits.length) { list.innerHTML = '<div class="empty-state">nothing logged yet.</div>'; return; }
  list.innerHTML = deposits.slice(0, 8).map(d => `
    <div class="ledger-row">
      <span class="ledger-amt">${fmtFull(d.amount)}</span>
      ${d.note ? `<span class="ledger-note">${esc(d.note)}</span>` : '<span class="ledger-note"></span>'}
      <span class="ledger-date">${parseLocalDate(d.deposit_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
    </div>`).join('');
}

// ── Trophy mini-tank (a finished fund's tank at 100%, in miniature) ─────────
function miniTankSVG(biomeKey) {
  const biome = BIOMES[biomeKey] || BIOMES.ocean;
  let html = `<rect x="0" y="0" width="400" height="300" fill="${biome.water}.16)"/>`;
  html += `<rect x="0" y="280" width="400" height="20" fill="${biome.sand}"/>`;
  for (const c of biome.creatures.filter(k => [20, 50, 85, 100].includes(k.pct))) {
    if (C[c.fn]) html += C[c.fn](c.x, c.y);
  }
  html = html.replace(/<animate[^>]*\/>/g, '');
  return `<svg viewBox="0 0 400 300" width="72" height="54" preserveAspectRatio="xMidYMid slice" aria-hidden="true" class="trophy-tank">${html}</svg>`;
}

// ── Progress Rendering ──────────────────────────────────────────────────────
function renderProgress(p) {
  const el = document.getElementById('progress-content');
  const tier = getTier(p.pct);
  const monthlyRate = getMonthlyRate();
  const projected = p.remaining > 0 && monthlyRate > 0 ? Math.ceil(p.remaining / monthlyRate) : 0;
  el.innerHTML = `
    <div class="tier-card">
      <div class="tier-emoji"><svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c3.6 4.4 6.5 8 6.5 11.4a6.5 6.5 0 0 1-13 0C5.5 10.5 8.4 6.9 12 2.5z" fill="${tier.color}"/><path d="M9.4 13.2a2.8 2.8 0 0 0 2.4 3.1" fill="none" stroke="rgba(23,30,48,.6)" stroke-width="1.4" stroke-linecap="round"/></svg></div>
      <div><div class="tier-label">${tier.name}</div><div class="tier-sub">${Math.floor(p.pct)}% of goal</div></div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-lbl">Total Saved</div><div class="stat-val teal">${fmt(p.total)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Goal</div><div class="stat-val">${fmt(p.target)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Remaining</div><div class="stat-val gold">${fmt(p.remaining)}</div></div>
      <div class="stat-card"><div class="stat-lbl">Progress</div><div class="stat-val teal">${Math.floor(p.pct)}%</div></div>
    </div>
    ${monthlyRate > 0 ? `<div class="card"><div class="sec-lbl">monthly deposit rate</div><div class="stat-val teal" style="font-size:1.1rem">${fmt(monthlyRate)}/mo</div>${projected > 0 ? `<div style="font-size:.75rem;color:var(--muted);margin-top:6px">At this rate: ~${projected} month${projected > 1 ? 's' : ''} to go</div>` : '<div style="font-size:.75rem;color:var(--seafoam);margin-top:6px">Goal reached!</div>'}</div>` : ''}
    ${renderMonthlyBars()}
    ${trophyGoals.length ? `<div class="card"><div class="sec-lbl">trophy shelf</div>${trophyGoals.map(t => `
      <div class="trophy-row">
        ${miniTankSVG(getGoalBiome(t.id))}
        <div><div class="trophy-name">${esc(t.name)}</div>
        <div class="trophy-sub">${fmt(t.target_amount)} fully stocked &middot; ${parseLocalDate(t.completed_at.slice(0, 10)).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</div></div>
      </div>`).join('')}</div>` : ''}
    ${activeGoal ? `<div class="card" style="margin-top:20px">
      <div class="sec-lbl">manage fund</div>
      <button class="btn btn-danger btn-sm" data-action="deleteGoal" data-goal-id="${esc(activeGoal.id)}" style="margin-bottom:8px">Delete "${esc(activeGoal.name)}"</button>
    </div>` : ''}
    <div class="card" style="margin-top:8px">
      <div class="sec-lbl">your data</div>
      <button class="btn btn-teal btn-sm" data-action="exportMyData" style="margin-bottom:8px">Download my data (JSON)</button>
      <div style="font-size:.7rem;color:var(--muted);margin-top:6px">Need to leave? Delete your account from Account settings in the footer below.</div>
    </div>
  `;
}
function getMonthlyRate() {
  if (!deposits.length) return 0;
  const dates = deposits.map(d => parseLocalDate(d.deposit_date));
  const earliest = new Date(Math.min(...dates));
  const months = Math.max((Date.now() - earliest) / (30.44 * 86400000), 1);
  return deposits.reduce((s, d) => s + d.amount, 0) / months;
}
function renderMonthlyBars() {
  if (!deposits.length) return '';
  const byMonth = {};
  deposits.forEach(d => { const m = d.deposit_date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + d.amount; });
  const months = Object.keys(byMonth).sort();
  const max = Math.max(...Object.values(byMonth));
  return `<div class="card"><div class="sec-lbl">monthly deposits</div>${months.map(m => {
    const pct = (byMonth[m] / max * 100).toFixed(0);
    return `<div class="month-bar-wrap"><div class="month-bar-label"><span>${m}</span><span>${fmt(byMonth[m])}</span></div><div class="month-bar-track"><div class="month-bar-fill" style="width:${pct}%;background:linear-gradient(90deg,var(--teal),var(--seafoam))"></div></div></div>`;
  }).join('')}</div>`;
}

// ── Fish-Dex ──────────────────────────────────────────────────────
const PRO_BIOME_KEYS = ['lake', 'deep', 'coralreef', 'arctic'];
function creatureMet(fn) { return achievements.has('|creature:' + fn); }

// Creatures become "met" the moment they appear in the active tank. Recorded
// user-level (goal_id '') so the collection persists across goals and devices.
function recordMetCreatures(p) {
  if (!activeGoal) return;
  const biome = BIOMES[getGoalBiome(activeGoal.id)] || BIOMES.ocean;
  const fresh = [...new Set(biome.creatures.filter(c => p.pct >= c.pct).map(c => 'creature:' + c.fn))]
    .filter(k => !achievements.has('|' + k));
  if (fresh.length) recordAchievements('', fresh);
}

function renderDex() {
  const el = document.getElementById('dex-content');
  if (!el) return;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seen = new Set();
  let total = 0, met = 0;
  const sections = [];
  for (const [key, biome] of Object.entries(BIOMES)) {
    const fns = [];
    for (const c of biome.creatures) if (!seen.has(c.fn)) { seen.add(c.fn); fns.push(c.fn); }
    if (!fns.length) continue;
    let secMet = 0;
    const cards = fns.map(fn => {
      total++;
      const m = creatureMet(fn);
      if (m) { met++; secMet++; }
      const meta = DEX[fn] || { name: fn, story: '' };
      let art = C[fn] ? C[fn](40, 40) : '';
      if (reduceMotion || !m) art = art.replace(/<animate[^>]*\/>/g, '');
      return `<div class="dex-card${m ? '' : ' dex-locked'}">
        <svg viewBox="-15 -25 110 120" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${m ? art : `<g class="dex-silhouette">${art}</g>`}</svg>
        <div class="dex-name">${m ? esc(meta.name) : '???'}</div>
        <div class="dex-story">${m ? esc(meta.story) : 'keep saving to meet this one.'}</div>
      </div>`;
    }).join('');
    sections.push({ name: biome.name, pro: PRO_BIOME_KEYS.includes(key), count: `${secMet}/${fns.length}`, cards });
  }
  el.innerHTML = `<div class="card"><div class="sec-lbl">fish-dex</div>
    <div class="dex-count">${met} of ${total} creatures met</div></div>` +
    sections.map(s => `<div class="card">
      <div class="sec-lbl" style="display:flex;align-items:center;gap:8px">${esc(s.name)}
        ${s.pro ? '<span class="pro-tag">PRO</span>' : ''}<span style="margin-left:auto;font-size:.7rem;opacity:.7">${s.count}</span></div>
      <div class="dex-grid">${s.cards}</div>
    </div>`).join('');
}

// Tap-to-inspect: tapping a creature in the tank shows its dex card in place.
let dexPopTimer = null;
function showDexPop(fn) {
  const wrap = document.getElementById('tank-wrap');
  if (!wrap) return;
  const meta = DEX[fn];
  if (!meta) return;
  wrap.querySelectorAll('.dex-pop').forEach(n => n.remove());
  clearTimeout(dexPopTimer);
  const pop = document.createElement('div');
  pop.className = 'dex-pop';
  pop.innerHTML = `<div class="dex-pop-name">${esc(meta.name)}</div><div class="dex-pop-story">${esc(meta.story)}</div>`;
  wrap.appendChild(pop);
  dexPopTimer = setTimeout(() => pop.remove(), 4000);
  pop.addEventListener('click', () => pop.remove());
}
document.getElementById('tank-svg').addEventListener('click', e => {
  const g = e.target.closest('.tank-creature');
  if (g) showDexPop(g.dataset.creature);
});
document.getElementById('tank-svg').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const g = e.target.closest('.tank-creature');
  if (g) { e.preventDefault(); showDexPop(g.dataset.creature); }
});

// ── Next-unlock tease ─────────────────────────────────────────────
// Silhouette of the next creature plus the exact dollars needed to meet it.
function renderTease(p) {
  const el = document.getElementById('next-unlock');
  if (!el) return;
  if (!activeGoal) { el.innerHTML = ''; return; }
  if (p.pct >= 100) {
    // Tank is full: the tease slot becomes the graduation invitation.
    el.innerHTML = `<div class="card tease-card">
      <div class="tease-txt"><div class="tease-lbl">fully stocked</div>
      <div class="tease-line">Retire this tank to your trophy shelf and free the slot for a new goal.</div></div>
      <button class="btn btn-teal btn-sm" data-action="graduateGoal" style="margin-left:auto;flex-shrink:0">Graduate this fund</button>
    </div>`;
    return;
  }
  const biome = BIOMES[getGoalBiome(activeGoal.id)] || BIOMES.ocean;
  const next = biome.creatures.find(c => c.pct > p.pct);
  if (!next || !C[next.fn]) { el.innerHTML = ''; return; }
  const needed = Math.max(0, (activeGoal.target_amount * next.pct / 100) - p.total);
  const meta = DEX[next.fn] || { name: next.fn };
  const art = C[next.fn](next.x, next.y).replace(/<animate[^>]*\/>/g, '');
  el.innerHTML = `<div class="card tease-card">
    <svg viewBox="${next.x - 45} ${next.y - 45} 90 90" width="52" height="52" preserveAspectRatio="xMidYMid meet" aria-hidden="true" class="tease-sil">${art}</svg>
    <div class="tease-txt"><div class="tease-lbl">next arrival</div>
    <div class="tease-line">save ${fmt(needed)} more to meet <strong>${esc(meta.name)}</strong></div></div>
  </div>`;
}

// ── Daily Tip ───────────────────────────────────────────────────────────────
function renderDailyTip() {
  const tip = GENERAL_NUDGES[Math.floor(Date.now() / 86400000) % GENERAL_NUDGES.length];
  document.getElementById('daily-tip').innerHTML = `
    <div class="tip-card">
      <div class="tip-text">${tip.text}</div>
      <a class="tip-cta" href="${tip.link}" target="_blank" rel="noopener">${tip.cta} &rarr;</a>
      ${isAff(tip.link)?'<div class="tip-disc">affiliate link</div>':''}
    </div>`;
}

// ── New arrivals ──────────────────────────────────────────
// A deposit that crosses a creature threshold is an EVENT: the creature pops
// into the tank with a burst at its spot, and the deposit popup leads with an
// arrival card (art + name + story) instead of the creature just appearing.
let arrivalPopFns = []; // one-shot: renderTank pops these in, then clears
function newlyArrived(prevPct, pct) {
  if (!activeGoal) return [];
  const biome = BIOMES[getGoalBiome(activeGoal.id)] || BIOMES.ocean;
  return biome.creatures.filter(c => c.pct > prevPct && c.pct <= pct && C[c.fn]);
}
function celebrateArrivals(arrivals) {
  if (!arrivals.length) return;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return;
  const svg = document.getElementById('tank-svg');
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return;
  arrivals.forEach((c, i) => {
    const bx = r.left + (c.x / 400) * r.width;
    const by = r.top + (c.y / 300) * r.height;
    setTimeout(() => burst(bx, by, 12), i * 180);
  });
}

// ── Add Deposit ─────────────────────────────────────────────────────────────
// In-flight guard: a double-tap must not save twice.
async function addDeposit() {
  if (addDeposit.busy) return;
  addDeposit.busy = true;
  try { await addDepositRun(); } finally { addDeposit.busy = false; }
}
async function addDepositRun() {
  const amount = parseFloat(document.getElementById('dep-amount').value);
  const date = document.getElementById('dep-date').value;
  const note = document.getElementById('dep-note').value;
  if (!amount || amount <= 0) { toast('Enter an amount'); return; }
  if (!activeGoal) { toast('Set a goal first!'); openOverlay('goal-modal', { gate: true }); return; }
  const prevPct = getProgress().pct;
  try {
    await api('/api/deposits', { method: 'POST', body: JSON.stringify({ goal_id: activeGoal.id, amount, deposit_date: date || undefined, note: note || undefined }) });
    // Reload deposits from server to ensure accuracy
    const freshDeposits = await api(`/api/deposits?goal_id=${activeGoal.id}`);
    depositsByGoal[activeGoal.id] = freshDeposits;
    deposits = freshDeposits;
    document.getElementById('dep-amount').value = '';
    document.getElementById('dep-note').value = '';
    const p = getProgress();
    const arrivals = newlyArrived(prevPct, p.pct);
    arrivalPopFns = arrivals.map(a => a.fn);
    renderAll();
    recordMetCreatures(p);
    celebrateArrivals(arrivals);
    // Check milestones FIRST (so the big celebration wins over mini).
    // When a milestone fires, the deposit confirmation popup waits until the
    // celebration overlay is closed so the big moment stays front and center.
    const milestoneHit = checkMilestones(p);
    if (milestoneHit) {
      pendingDepositPopup = { amount, p, nudgeKey: lastMilestoneNudgeKey, arrivals };
    } else {
      miniCelebrate(amount, p.pct);
      showDepositPopup(amount, p, undefined, arrivals);
    }
  } catch (e) { toast(e.message); }
}
async function deleteDeposit(id) {
  const ok = await showConfirm({
    title: 'Delete this deposit?',
    message: 'This deposit will be removed from your fund history.',
    confirmLabel: 'Delete deposit',
  });
  if (!ok) return;
  try {
    await api(`/api/deposits/${id}`, { method: 'DELETE' });
    // Reload from server to ensure accuracy
    const freshDeposits = await api(`/api/deposits?goal_id=${activeGoal.id}`);
    depositsByGoal[activeGoal.id] = freshDeposits;
    deposits = freshDeposits;
    renderAll();
    toast('Deposit deleted');
  } catch (e) { toast(e.message); }
}

// ── Graduated Celebrate (every deposit, scaled by progress) ─────────────────
function miniCelebrate(amount, pct) {
  const tank = document.getElementById('tank-wrap');
  const rect = tank.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height * 0.3;

  // Always: floating amount + crab reaction + toast
  const floater = document.createElement('div');
  floater.className = 'deposit-float';
  floater.textContent = '+' + fmt(amount);
  floater.style.left = (cx - 40) + 'px';
  floater.style.top = (rect.top + rect.height * 0.4) + 'px';
  document.body.appendChild(floater);
  setTimeout(() => floater.remove(), 1500);
  toast('Deposit added!');

  if (pct < 10) {
    // Tiny: just a few bubbles + pleased crab
    reactCrab('pleased');
    burst(cx, cy, 4);
  } else if (pct < 25) {
    // Small: gentle flash + small burst
    reactCrab('pleased');
    burst(cx, cy, 8);
    flashScreen('rgba(92,225,230,.06)');
  } else if (pct < 50) {
    // Medium: flash + burst + extra burst from crab
    reactCrab('pleased');
    burst(cx, cy, 12);
    flashScreen('rgba(207,242,90,.08)');
    const wrap = document.querySelector('.character-wrap');
    const cr = wrap.getBoundingClientRect();
    setTimeout(() => burst(cr.left + cr.width / 2, cr.top + cr.height / 2, 6), 200);
  } else if (pct < 75) {
    // Big: double flash + big burst + crab bounce
    reactCrab('pleased');
    burst(cx, cy, 16);
    flashScreen('rgba(207,242,90,.1)');
    setTimeout(() => flashScreen('rgba(92,225,230,.08)'), 200);
    setTimeout(() => burst(Math.random() * window.innerWidth, Math.random() * window.innerHeight, 8), 300);
  } else if (pct < 100) {
    // Huge: triple flash + multiple bursts + confetti lite
    reactCrab('pleased');
    burst(cx, cy, 20);
    flashScreen('rgba(207,242,90,.12)');
    setTimeout(() => flashScreen('rgba(92,225,230,.1)'), 200);
    setTimeout(() => flashScreen('rgba(255,138,92,.08)'), 400);
    for (let i = 0; i < 3; i++) {
      setTimeout(() => burst(Math.random() * window.innerWidth, Math.random() * window.innerHeight, 10), i * 200);
    }
    fireConfetti(30);
  } else {
    // 100%+ OBNOXIOUS: everything at max
    reactCrab('celebrating');
    // Rapid-fire screen flashes
    flashScreen('rgba(207,242,90,.2)');
    setTimeout(() => flashScreen('rgba(92,225,230,.18)'), 150);
    setTimeout(() => flashScreen('rgba(255,138,92,.15)'), 300);
    setTimeout(() => flashScreen('rgba(255,200,87,.12)'), 450);
    setTimeout(() => flashScreen('rgba(182,156,255,.15)'), 600);
    // Massive particle storm
    for (let i = 0; i < 8; i++) {
      setTimeout(() => burst(Math.random() * window.innerWidth, Math.random() * window.innerHeight, 18), i * 150);
    }
    // Extra bursts from the tank
    burst(cx, cy, 24);
    setTimeout(() => burst(cx - 80, cy + 40, 16), 100);
    setTimeout(() => burst(cx + 80, cy + 40, 16), 200);
    // Max confetti
    fireConfetti(120);
    setTimeout(() => fireConfetti(80), 500);
    setTimeout(() => reactCrab('idle'), 4000);
  }
}

// ── Deposit Popup (every deposit gets one) ──────────────────────────────────
function showDepositPopup(amount, p, nudgeKey, arrivals) {
  // Remove any existing popup
  document.querySelectorAll('.dep-popup').forEach(el => el.remove());
  const popup = document.createElement('div');
  let cls = 'dep-popup';
  let msg = '';
  if (p.pct >= 100 && p.pct < 110) {
    cls += ' goal-met';
    msg = `<div class="pop-msg" style="font-size:1rem;font-weight:700;color:var(--gold)">GOAL REACHED!</div><div class="pop-msg">Your fund is fully stocked. You did it!</div>`;
  } else if (p.pct >= 110) {
    cls += ' exceeded';
    msg = `<div class="pop-msg" style="font-size:1rem;font-weight:700;color:var(--coral)">OVERFLOWING!</div><div class="pop-msg">You're ${Math.floor(p.pct)}% of goal. Legendary.</div>`;
  } else if (p.pct >= 75) {
    msg = `<div class="pop-msg">Almost there! ${Math.floor(p.pct)}% of your goal.</div><div class="pop-msg">${fmt(p.remaining)} to go!</div>`;
  } else if (p.pct >= 50) {
    msg = `<div class="pop-msg">Over halfway! ${Math.floor(p.pct)}% of your goal.</div>`;
  } else if (p.pct >= 25) {
    msg = `<div class="pop-msg">${Math.floor(p.pct)}% of your goal. The reef is growing!</div>`;
  } else if (p.pct >= 10) {
    msg = `<div class="pop-msg">${Math.floor(p.pct)}% of your goal. Keep it up!</div>`;
  } else {
    msg = `<div class="pop-msg">Every drop counts. ${Math.floor(p.pct)}% so far.</div>`;
  }
  // Nudge cap: milestone deposits + every 3rd deposit only.
  // Everything else celebrates promo-free. deposits is already refreshed from
  // the server before this popup fires, so length is the true count.
  const isMilestone = !!(nudgeKey && MILESTONE_NUDGES[nudgeKey]);
  const everyThird = deposits.length > 0 && deposits.length % 3 === 0;
  const nudge = isMilestone ? MILESTONE_NUDGES[nudgeKey] : GENERAL_NUDGES[Math.floor(Math.random() * GENERAL_NUDGES.length)];
  const nudgeHtml = (isMilestone || everyThird)
    ? `<div class="tip-card" style="margin:10px 0 4px;text-align:left"><div class="tip-text">${nudge.text}</div><a class="tip-cta" href="${nudge.link}" target="_blank" rel="noopener">${nudge.cta} &rarr;</a>${isAff(nudge.link)?'<div class="tip-disc">affiliate link</div>':''}</div>`
    : '';
  // New-arrival cards: the unlock IS the headline of this popup.
  const uniqArrivals = [];
  const seenFn = new Set();
  (arrivals || []).forEach(a => { if (!seenFn.has(a.fn)) { seenFn.add(a.fn); uniqArrivals.push(a); } });
  const arrivalsHtml = uniqArrivals.length ? `<div class="arrivals-wrap">${uniqArrivals.slice(0, 3).map(a => {
    const m = DEX[a.fn] || { name: a.fn, story: '' };
    const art = C[a.fn] ? C[a.fn](40, 40).replace(/<animate[^>]*\/>/g, '') : '';
    return `<div class="arrival-card"><svg viewBox="-15 -25 110 120" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${art}</svg><div class="arrival-txt"><div class="arrival-lbl">new arrival</div><div class="arrival-name">${esc(m.name)}</div><div class="arrival-story">${esc(m.story)}</div></div></div>`;
  }).join('')}${uniqArrivals.length > 3 ? `<div class="arrival-more">+${uniqArrivals.length - 3} more just moved in</div>` : ''}</div>` : '';
  popup.className = cls;
  popup.innerHTML = `
    <div class="pop-amount">+${fmtFull(amount)}</div>
    ${arrivalsHtml}
    ${msg}
    <div class="pop-pct">${fmt(p.total)} / ${fmt(p.target)}</div>
    ${nudgeHtml}
    <button class="pop-close" data-action="popClose">Nice!</button>
  `;
  document.body.appendChild(popup);
  // Auto-close after 8s (longer to allow reading nudge)
  setTimeout(() => { if (popup.parentElement) popup.remove(); }, 8000);
}

// ── Achievements sync (server is truth, localStorage is cache) ────
let achievements = new Set(); // '<goal_id>|<key>' — creature keys live at goal_id ''
async function loadAchievements() {
  try {
    const d = await api('/api/achievements');
    achievements = new Set((d.achievements || []).map(a => a.goal_id + '|' + a.key));
  } catch { /* offline: fall back to localStorage checks */ }
}
function recordAchievements(goalId, keys) {
  keys.forEach(k => achievements.add(goalId + '|' + k));
  api('/api/achievements', { method: 'POST', body: JSON.stringify({ goal_id: goalId, keys }) }).catch(() => {});
}

// One-time push of older localStorage state to the server. Biome: only
// for goals the server still has as NULL (grandfather stamp, any legacy biome
// allowed). Milestones: merged idempotently into achievements.
async function migrateLocalState() {
  for (const g of goals) {
    if (!g.biome) {
      const localBiome = localStorage.getItem('efa_biome_' + g.id) || 'ocean';
      try {
        await api(`/api/goals/${g.id}`, { method: 'PUT', body: JSON.stringify({ biome: localBiome }) });
        g.biome = localBiome;
      } catch { /* keep localStorage fallback; retry next load */ }
    }
    const localMs = JSON.parse(localStorage.getItem('efa_milestones_' + g.id) || '[]');
    const unsynced = localMs.filter(k => !achievements.has(g.id + '|' + k));
    if (unsynced.length) recordAchievements(g.id, unsynced);
  }
}

// ── Milestone Check ─────────────────────────────────────────────────────────
// Celebrations queue: FIRST SPLASH plays first if newly earned, then the
// highest newly-crossed percentage milestone. Each shows after the previous
// overlay is closed; the deposit confirmation popup comes last (see closeCeleb).
let milestoneQueue = [];
let pendingDepositPopup = null;
let lastMilestoneNudgeKey = null;
function checkMilestones(p) {
  if (!activeGoal) return false;
  const storageKey = 'efa_milestones_' + activeGoal.id;
  const localHit = JSON.parse(localStorage.getItem(storageKey) || '[]');
  // Also clear any old-format milestone keys
  localStorage.removeItem('efa_milestones');
  // Server achievements are the dedup source of truth; localStorage stays as
  // an offline cache so a flaky connection can't replay celebrations.
  const already = k => achievements.has(activeGoal.id + '|' + k) || localHit.includes(k);
  const newlyHit = MILESTONES.filter(m => !already(m.key) && m.check(p.pct, deposits));
  if (!newlyHit.length) return false;
  newlyHit.forEach(m => localHit.push(m.key));
  localStorage.setItem(storageKey, JSON.stringify(localHit));
  recordAchievements(activeGoal.id, newlyHit.map(m => m.key));
  const queue = [];
  const firstSplash = newlyHit.find(m => m.key === 'first-drop');
  if (firstSplash) queue.push(firstSplash);
  const pctMilestones = newlyHit.filter(m => m.key !== 'first-drop');
  if (pctMilestones.length) queue.push(pctMilestones[pctMilestones.length - 1]);
  lastMilestoneNudgeKey = queue[queue.length - 1].key;
  milestoneQueue = queue;
  setTimeout(playNextMilestone, 600);
  return true;
}
function playNextMilestone() {
  const m = milestoneQueue.shift();
  if (m) celebrateFull(m);
}

// ── Full Celebration ────────────────────────────────────────────────────────
function celebrateFull(milestone) {
  const isGoalReached = milestone.key === 'goal-reached';
  reactCrab('celebrating');

  if (isGoalReached) {
    // === ABSOLUTE MAXIMUM OBNOXIOUS EXPLOSION ===
    // Rapid-fire rainbow flashes
    const flashColors = ['rgba(207,242,90,.25)','rgba(92,225,230,.22)','rgba(255,138,92,.2)','rgba(255,200,87,.18)','rgba(182,156,255,.2)','rgba(207,242,90,.18)','rgba(255,138,92,.2)','rgba(92,225,230,.22)'];
    flashColors.forEach((c, i) => setTimeout(() => flashScreen(c), i * 120));
    // Massive particle storm — 12 waves
    for (let w = 0; w < 12; w++) {
      setTimeout(() => burst(Math.random() * window.innerWidth, Math.random() * window.innerHeight, 20), w * 180);
    }
    // Triple confetti
    fireConfetti(150);
    setTimeout(() => fireConfetti(120), 400);
    setTimeout(() => fireConfetti(100), 800);
  } else {
    // Normal milestone celebration (still exciting)
    flashScreen('rgba(207,242,90,.15)');
    setTimeout(() => flashScreen('rgba(92,225,230,.12)'), 300);
    setTimeout(() => flashScreen('rgba(255,138,92,.1)'), 600);
    for (let w = 0; w < 5; w++) {
      setTimeout(() => burst(Math.random() * window.innerWidth, Math.random() * window.innerHeight, 14), w * 250);
    }
    fireConfetti(80);
  }

  // Show overlay. The celebration itself stays promo-free: any milestone
  // nudge rides along on the deposit confirmation popup that follows instead.
  setTimeout(() => {
    document.getElementById('celeb-title').textContent = milestone.title;
    document.getElementById('celeb-msg').innerHTML = milestone.msg;
    document.getElementById('celeb-nudge').innerHTML = '';
    openOverlay('celeb-overlay');
  }, isGoalReached ? 1200 : 900);
  setTimeout(() => reactCrab('idle'), isGoalReached ? 8000 : 6000);
}
// "Keep Going" advances the celebration queue, so it must NOT route through
// history.back(): each queued milestone opens its own layer, and unwinding one
// while queueing the next would leave the stack and history disagreeing. The
// entry is consumed instead — the celebration that just played is over.
// A Back press takes the other path (OVERLAY_TEARDOWN drains the whole queue),
// because Back means "I'm done celebrating", not "show me the next one".
function closeCeleb() {
  consumeOverlay('celeb-overlay');
  // Play the next queued milestone, then finally the held deposit popup.
  if (milestoneQueue.length) { setTimeout(playNextMilestone, 300); return; }
  if (pendingDepositPopup) {
    const { amount, p, nudgeKey, arrivals } = pendingDepositPopup;
    pendingDepositPopup = null;
    showDepositPopup(amount, p, nudgeKey, arrivals);
  }
}

// ── Confetti ────────────────────────────────────────────────────────────────
function fireConfetti(count = 80) {
  const canvas = document.getElementById('confetti-canvas');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const colors = ['#CFF25A', '#5CE1E6', '#FF8A5C', '#FFC857', '#CFF25A', '#B69CFF', '#FFC857'];
  const pieces = [];
  for (let i = 0; i < count; i++) {
    pieces.push({ x: Math.random() * canvas.width, y: -20 - Math.random() * 200, w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, color: colors[Math.floor(Math.random() * colors.length)], rot: Math.random() * 360, rotV: (Math.random() - .5) * 8, vy: 1.5 + Math.random() * 3, vx: (Math.random() - .5) * 2, opacity: 1 });
  }
  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    pieces.forEach(p => {
      if (p.opacity <= 0) return;
      alive = true;
      p.y += p.vy; p.x += p.vx; p.rot += p.rotV;
      if (p.y > canvas.height + 20) { p.opacity = 0; return; }
      if (frame > 100) p.opacity -= .015;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot * Math.PI / 180);
      ctx.globalAlpha = Math.max(p.opacity, 0);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    frame++;
    if (alive) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  draw();
}

// ── Particles ───────────────────────────────────────────────────────────────
function burst(x, y, count = 12) {
  const colors = ['#CFF25A', '#5CE1E6', '#FF8A5C', '#FFC857', '#CFF25A'];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * .5;
    const dist = 40 + Math.random() * 60;
    const p = document.createElement('div');
    p.className = 'particle';
    const size = 4 + Math.random() * 6;
    p.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px;background:${colors[i % colors.length]};--tx:${Math.cos(angle) * dist}px;--ty:${Math.sin(angle) * dist}px;--dur:${(.5 + Math.random() * .5).toFixed(2)}s;--rot:${Math.random() * 720}deg`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1200);
  }
}
function flashScreen(color) {
  const f = document.createElement('div');
  f.style.cssText = `position:fixed;inset:0;background:${color};z-index:997;pointer-events:none;animation:screen-flash .5s forwards`;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 600);
}

// ── Crab Interactions ───────────────────────────────────────────────────────
let crabTimeout;
function crabClick() {
  const line = CRAB_LINES[Math.floor(Math.random() * CRAB_LINES.length)];
  document.getElementById('speechBubble').innerHTML = line;
  reactCrab('pleased');
  const wrap = document.querySelector('.character-wrap');
  const rect = wrap.getBoundingClientRect();
  burst(rect.left + rect.width / 2, rect.top + rect.height / 2, 8);
  clearTimeout(crabTimeout);
  crabTimeout = setTimeout(() => syncCrab(getProgress()), 3500);
}
function reactCrab(state) {
  const svg = document.getElementById('crabSVG');
  svg.className.baseVal = `crab-char state-${state}`;
  if (state === 'pleased') setTimeout(() => { svg.className.baseVal = 'crab-char state-idle'; }, 1200);
}
function syncCrab(p) {
  // Speech
  const line = CRAB_PROGRESS.find(l => p.pct >= l.min && p.pct <= l.max);
  if (line) document.getElementById('speechBubble').innerHTML = line.line;
  // Puff's body IS the progress bar: redraw him at this percentage, keeping his animation state.
  const old = document.getElementById('crabSVG');
  if (!old) return;
  const holder = document.createElement('div');
  holder.innerHTML = puffSvg(p.pct, 'pf', 250, 238);
  const svg = holder.firstElementChild;
  svg.id = 'crabSVG';
  svg.setAttribute('class', old.getAttribute('class') || 'crab-char state-idle');
  old.replaceWith(svg);
}
function scheduleBlink() {
  const blink = () => {
    const eyes = document.querySelector('#crabSVG .puff-eyes');
    if (!eyes) return;
    eyes.classList.add('blink');
    setTimeout(() => eyes.classList.remove('blink'), 150);
  };
  setInterval(() => { setTimeout(blink, Math.random() * 3500); }, 1800 + Math.random() * 3500);
}

// ── Styled confirm (Promise-based replacement for native confirm()) ────────
let confirmResolve = null;
function showConfirm({ title, message, confirmLabel = 'Delete', danger = true }) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-msg').textContent = message;
    const ok = document.getElementById('confirm-modal-ok');
    ok.textContent = confirmLabel;
    ok.classList.toggle('btn-danger', danger);
    ok.classList.toggle('btn-seafoam', !danger);
    openOverlay('confirm-modal');
    ok.focus();
  });
}
// Both answers settle the promise here, so the entry is consumed rather than
// unwound — routing Yes through history.back() would resolve the promise
// asynchronously on popstate, after the caller already moved on.
function closeConfirm(result) {
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(result); }
  consumeOverlay('confirm-modal');
}
document.getElementById('confirm-modal-ok').addEventListener('click', () => closeConfirm(true));
document.getElementById('confirm-modal-cancel').addEventListener('click', () => closeConfirm(false));
document.getElementById('confirm-modal').addEventListener('click', e => { if (e.target.id === 'confirm-modal') closeConfirm(false); });

// ── Account Delete (styled two-step modal: warning → fresh proof) ──────────
// Deleting an account asks for the current password.
function setDeleteMode() {
  document.getElementById('delete-account-err').style.display = 'none';
  document.getElementById('delete-account-pw').focus();
}
function confirmDeleteAccount() {
  document.getElementById('delete-account-step1').style.display = '';
  document.getElementById('delete-account-step2').style.display = 'none';
  document.getElementById('delete-account-err').style.display = 'none';
  document.getElementById('delete-account-pw').value = '';
  openOverlay('delete-account-modal');
}
function deleteAccountContinue() {
  document.getElementById('delete-account-step1').style.display = 'none';
  document.getElementById('delete-account-step2').style.display = '';
  setDeleteMode();
}
function closeDeleteAccount(fromHistory) { closeOverlay('delete-account-modal', fromHistory); }
async function deleteAccountConfirm(e) {
  e.preventDefault();
  const errEl = document.getElementById('delete-account-err');
  const btn = document.getElementById('delete-account-confirm-btn');
  const fail = (m) => { errEl.textContent = m; errEl.style.display = 'block'; };
  errEl.style.display = 'none';
  const pw = document.getElementById('delete-account-pw').value;
  if (!pw) return;
  const body = { current_password: pw };
  btn.disabled = true;
  try {
    await api('/api/auth/account', { method: 'DELETE', body: JSON.stringify(body) });
    consumeOverlay('delete-account-modal'); // account is gone; the entry is stale
    logout();
  } catch (err) {
    fail(err.message || 'Could not delete your account.');
  }
  btn.disabled = false;
}

// ── Change password (Account settings) ──────────────────────────────────────
// PUT /api/auth/password bumps token_version, which ends every other session,
// and sets a fresh session cookie for this one so the person stays logged in.
function openPasswordModal() {
  ['pw-current', 'pw-new'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('password-err').style.display = 'none';
  openOverlay('password-modal');
}
function closePasswordModal(fromHistory) { closeOverlay('password-modal', fromHistory); }
async function savePassword(e) {
  e.preventDefault();
  const cur = document.getElementById('pw-current').value, nw = document.getElementById('pw-new').value;
  const errEl = document.getElementById('password-err'), btn = document.getElementById('pw-save-btn');
  const fail = (m) => { errEl.textContent = m; errEl.style.display = 'block'; };
  if (!cur) return fail('Enter your current password.');
  if (nw.length < 10 || nw.length > 200) return fail('Your new password needs 10 to 200 characters.');
  btn.disabled = true; errEl.style.display = 'none';
  try {
    const d = await api('/api/auth/password', { method: 'PUT', body: JSON.stringify({ current_password: cur, password: nw }) });
    // The server set a fresh session cookie with the new token_version.
    consumeOverlay('password-modal'); // done; Back must not reopen a finished form
    toast('Password changed');
  } catch (err) {
    fail(err.message || 'Could not change your password.');
  }
  btn.disabled = false;
}

// ── GDPR data export ─────────────────────────────────────────────────────────
async function exportMyData() {
  try {
    const r = await fetch(API + '/api/account/export', { credentials: 'same-origin' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'Could not export your data');
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'emergency-fund-aquarium-export.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Download started');
  } catch (e) { toast(e.message); }
}

// ── Modals ──────────────────────────────────────────────────────────────────
function showPrivacy() { openOverlay('privacy-modal'); }
function closeModal(id, fromHistory) { closeOverlay(id, fromHistory); }

// ── BROWSER BACK/FORWARD ─────────────────────────────────────────────────────
// Transient, non-stacked bits of UI: no backdrop, no focus trap, so they never
// earn a history entry — but a Back press should still clear them.
function clearTransientOverlays() {
  document.querySelectorAll('.dex-pop').forEach(n => n.remove());
  clearTimeout(dexPopTimer);
  document.querySelectorAll('.dep-popup').forEach(n => n.remove());
}

// Tears every stacked layer down, gates included. Used when the user leaves
// the whole authed view (logout), not on an ordinary Back — a Back press pops
// one layer via unwindOverlaysTo(), because Back means "undo the step I took",
// not "close everything I ever opened".
function closeAllOverlays() {
  while (overlayStack.length) popOverlayLayer();
  clearTransientOverlays();
}

// Restores a pre-auth history entry (login/signup tab, or the verify-code
// box). authTab() already resets the auth-screen DOM to a clean baseline
// (hides the verify box, shows the credential form) every time it runs, so
// layering showCodeEntry() on top after it is enough — no separate DOM-only
// reset helper needed here.
function restoreAuthView(state) {
  if (state && (state.guestView === 'build' || state.guestView === 'tank')) { showGuest(state.guestView, { fromHistory: true }); return; }
  const view = (state && state.authView) || 'login';
  const mode = state && state.mode === 'signup' ? 'signup' : 'login';
  authTab(mode, true);
  if (view === 'verify') showCodeEntry((state && state.email) || '', true);
}

window.addEventListener('popstate', (ev) => {
  const state = ev.state || {};
  clearTransientOverlays();
  // Pop only as many layers as this entry gives back. A Back press out of the
  // Pro gate opened from the goal form lands on the goal form, values intact —
  // not on the bare tank, and not off the origin.
  unwindOverlaysTo(state.efaOverlay || 0);
  // The tab/fund restore below still runs even if a layer remains: goTab and
  // switchGoal only touch the view underneath, never the overlay stack.
  if (currentUser) {
    // Authenticated: restore the in-app tab + active fund. A stale pre-auth
    // entry (no `view` — e.g. left over from before login) defaults to the
    // aquarium landing.
    goTab(state.view || 'aquarium', true);
    if ('goalId' in state) switchGoal(state.goalId, true);
  } else {
    // Not authenticated (including right after a post-logout reload):
    // restore the auth-screen step. A stale in-app entry (no `authView`)
    // defaults to the login landing.
    restoreAuthView(state);
  }
});

// ── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  // Demo tank on the logged-out screen (fixed sample data, no auth involved)
  renderDemoTank();
  // Set default date
  document.getElementById('dep-date').value = todayLocalISO();
  // Check reset token
  const params = new URLSearchParams(location.search);
  if (getResetToken()) {
    hideBootScreen();
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('reset-screen').style.display = 'flex';
    return;
  }
  // Landing view is always the login tab (static HTML default) — replaceState
  // so the very first Back leaves the site. If auto-login succeeds moments
  // later, enterApp()'s own replaceState collapses this into the app landing.
  // logout() reloads the page rather than pushing a new history entry, so
  // this same line is also what collapses a post-logout page back to a clean
  // auth landing (the reload re-runs init() against the same top-of-stack
  // history entry that still held the old session's tab/fund state).
  // Logged-out landing is "build your tank", not a sign-up wall. A refresh on the log-in or sign-up card stays there. Always
  // replaceState, so the very first Back leaves the site. If a session logs the
  // user in below, enterApp()'s own replaceState overwrites this.
  if (BOOT_ENTRY.authView === 'login' || BOOT_ENTRY.authView === 'signup') landAuth(BOOT_ENTRY.authView);
  else {
    // Reading the stored goal re-validates it, which also purges a tampered one.
    const pending = readGuestGoal();
    showGuest(BOOT_ENTRY.guestView === 'build' || !pending ? 'build' : 'tank', { replace: true });
  }
  try {
  // Who is signed in? One GET /api/me (the cookie is HttpOnly).
  let bootErr = null;
  {
    // Pre-cookie builds kept the login token in localStorage. It's dead
    // now (the server only reads the cookie), so just wipe any leftover.
    try { localStorage.removeItem('efa_token'); } catch (e) {}
    try { currentUser = await api('/api/me'); }
    catch (err) { if (!err.sessionEnded) bootErr = err.message; }
  }
  // Auto-login
  if (currentUser) {
    try { await enterApp(false); } catch { logout(); }
  } else {
    if (bootErr) landAuth('login');
    showAuthScreen();
    if (bootErr) { const el = document.getElementById('auth-err'); el.textContent = bootErr; el.style.display = 'block'; }
  }
  } finally {
    // Nobody gets stranded on the boot screen. If it is still up by now, no
    // session resolved, which means the auth screen.
    const boot = document.getElementById('boot-screen');
    if (boot && boot.style.display !== 'none') showAuthScreen();
  }
})();

// ── Feedback widget config (was inline) ─────────────────────────────────────
window.FEEDBACK_APP = 'Emergency Fund Aquarium';

// ── Feedback widget: logged-in only ─────────────────────────────────────────
// No static script tag: the widget is lazy-loaded the first time the logged-in
// app learns from /api/pro-status that feedback is turned on. Logout reloads the page,
// which removes the injected script and button, so the logged-out screen never
// shows a feedback button or loads the widget script.
let feedbackWidgetLoaded = false;
function loadFeedbackWidget() {
  if (feedbackWidgetLoaded) return;
  feedbackWidgetLoaded = true;
  const s = document.createElement('script');
  s.src = '/feedback-widget.js?v=20260821a';
  s.defer = true;
  document.body.appendChild(s);
}

// ── Event delegation (replaces inline onclick/onsubmit attributes) ──────────
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  switch (action) {
    case 'authTab':       authTab(t.dataset.mode); break;
    case 'verifyCodeResend': verifyCodeResend(); break;
    case 'forgotPw':      forgotPw(); break;
    case 'confirmReset':  confirmReset(); break;
    case 'openHelp':      openHelp(); break;
    case 'close-help':    closeHelp(); break;
    case 'start-tour':    closeHelp(); setTimeout(startTour, 220); break;
    case 'tip-act':       runTipAction(t.dataset.tipAct); break;
    case 'logout':        logout(); break;
    case 'crabClick':     crabClick(); break;
    case 'goTab':         goTab(t.dataset.tab); break;
    case 'addDeposit':    addDeposit(); break;
    case 'closeCeleb':    closeCeleb(); break;
    case 'closeModal':    closeModal(t.dataset.modal); break;
    case 'closeOnboard':  closeOnboard(); break;
    case 'pickBiome':     pickBiome(t, t.dataset.biome); break;
    case 'createGoal':    createGoal(); break;
    case 'switchGoal':    switchGoal(t.dataset.goalId); break;
    case 'showAddGoalModal': showAddGoalModal(); break;
    case 'deleteDeposit': deleteDeposit(t.dataset.depositId); break;
    case 'deleteGoal':    deleteGoal(t.dataset.goalId); break;
    case 'graduateGoal':  graduateGoal(); break;
    case 'exportMyData':  exportMyData(); break;
    case 'retryLoad':     loadAppData(false); break;
    case 'confirmDeleteAccount': confirmDeleteAccount(); break;
    case 'deleteAccountContinue': deleteAccountContinue(); break;
    case 'closeDeleteAccount': closeDeleteAccount(); break;
    case 'openPasswordModal': openPasswordModal(); break;
    case 'closePasswordModal': closePasswordModal(); break;
    case 'demoDeposit':   demoDeposit(); break;
    case 'guestBiome':    pickGuestBiome(t.dataset.biome); break;
    case 'guestSignup':   leaveGuestTo('signup'); break;
    case 'guestLogin':    leaveGuestTo('login'); break;
    case 'guestEdit':     showGuest('build'); break;
    case 'guestTry':      showGuest(readGuestGoal() ? 'tank' : 'build'); break;
    case 'firstDeposit':  goTab('deposit'); { const a = document.getElementById('dep-amount'); if (a) a.focus(); } break;
    case 'showPrivacy':   showPrivacy(); break;
    case 'popClose':      if (t.parentElement) t.parentElement.remove(); break;
  }
});

// Guest build: the preview tank follows the target amount as it's typed.
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'guest-amount' && guestView === 'build') previewGuestBuild();
  if (e.target && (e.target.id === 'guest-amount' || e.target.id === 'guest-name') && guestView === 'build') saveGuestDraft();
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-action-submit]');
  if (!f) return;
  const action = f.dataset.actionSubmit;
  if (action === 'authSubmit') authSubmit(e);
  else if (action === 'verifyCodeSubmit') verifyCodeSubmit(e);
  else if (action === 'guestBuildSubmit') guestBuildSubmit(e);
  else if (action === 'deleteAccountConfirm') deleteAccountConfirm(e);
  else if (action === 'savePassword') savePassword(e);
  // Enter in the reset form submits it; the button's click handler is the
  // other way in, so stop the form's native submit from firing it twice.
  else if (action === 'confirmReset') { e.preventDefault(); }
});

// The crab is a div with role=button: Enter and Space must poke it too.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest && e.target.closest('[data-action="crabClick"]');
  if (!t) return;
  e.preventDefault();
  crabClick();
});

// ── Show/hide password toggle ─────────
(function initPwEyes(){
  var EYE='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYEOFF='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  ['auth-pw','auth-pw2'].forEach(function(id){
    var input=document.getElementById(id);
    if(!input||input.dataset.eyeInit)return;
    input.dataset.eyeInit='1';
    var wrap=document.createElement('div');
    wrap.style.position='relative';
    input.parentNode.insertBefore(wrap,input);
    wrap.appendChild(input);
    input.style.paddingRight='40px';
    var btn=document.createElement('button');
    btn.type='button';
    btn.setAttribute('aria-label','Show password');
    btn.setAttribute('aria-pressed','false');
    btn.style.cssText='position:absolute;right:4px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:8px;line-height:0;color:inherit;opacity:.55';
    btn.innerHTML=EYE;
    btn.addEventListener('click',function(){
      var show=input.type==='password';
      input.type=show?'text':'password';
      btn.innerHTML=show?EYEOFF:EYE;
      btn.setAttribute('aria-label',show?'Hide password':'Show password');
      btn.setAttribute('aria-pressed',String(show));
      input.focus();
    });
    wrap.appendChild(btn);
  });
})();


// PUFF THE PUFFERFISH: the Aquarium's mascot.
// Single source. recolor-anglerfish.py appends this to public/app.js and renders the static copies
// (404, og preview) through node, so every Puff on the site is drawn by this one function.
// He shows the fund on his body: at 0% he's small and worried, and every deposit puffs him up
// rounder until his spikes are all the way out at 100%.
function puffSvg(pct, uid, w, h) {
  uid = uid || 'pf';
  const p = Math.max(0, Math.min(1, (+pct || 0) / 100));
  const r = 34 + 30 * p, cx = 110, cy = 104, n = 14, spikeLen = 2 + 12 * p;
  const eye = (x, y, er, look) =>
    `<circle cx="${x}" cy="${y}" r="${er}" fill="#fff"/>` +
    `<circle cx="${x + look}" cy="${y + 1}" r="${er * 0.62}" fill="#1B2440"/>` +
    `<circle cx="${x + look - er * 0.22}" cy="${y - er * 0.25}" r="${er * 0.24}" fill="#fff"/>` +
    `<circle cx="${x + look + er * 0.2}" cy="${y + er * 0.22}" r="${er * 0.1}" fill="#fff"/>`;
  let spikes = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.2;
    if (Math.cos(a) < -0.75) continue; // room for the tail
    const bx = cx + Math.cos(a) * (r - 2), by = cy + Math.sin(a) * (r - 2);
    const tx = cx + Math.cos(a) * (r + spikeLen), ty = cy + Math.sin(a) * (r + spikeLen);
    const px = -Math.sin(a) * 4, py = Math.cos(a) * 4;
    spikes += `<path d="M${(bx + px).toFixed(1)} ${(by + py).toFixed(1)} L${tx.toFixed(1)} ${ty.toFixed(1)} L${(bx - px).toFixed(1)} ${(by - py).toFixed(1)}Z" fill="#E7A21E"/>`;
  }
  const tl = cx - r - 4;
  const mx = cx + r * 0.42, my = cy + r * 0.18, mw = 5 + p * 5;
  const mouth = p < 0.1
    ? `<ellipse cx="${mx}" cy="${cy + r * 0.22}" rx="4" ry="5" fill="#3A1E12"/>`
    : `<path d="M${mx - mw} ${my} Q${mx} ${my + 2 + p * 10} ${mx + mw} ${my}" fill="none" stroke="#3A1E12" stroke-width="3" stroke-linecap="round"/>`;
  const size = (w ? ` width="${w}"` : '') + (h ? ` height="${h}"` : '');
  return `<svg viewBox="0 0 220 210"${size} xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Puff the pufferfish, ${Math.round(p * 100)}% puffed up">` +
    `<defs><radialGradient id="${uid}B" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#FFE38A"/><stop offset=".6" stop-color="#FFC43D"/><stop offset="1" stop-color="#EE9F14"/></radialGradient>` +
    `<radialGradient id="${uid}W" cx=".5" cy=".3" r=".8"><stop offset="0" stop-color="#FFFBEA"/><stop offset="1" stop-color="#FCE7B0"/></radialGradient></defs>` +
    `<ellipse cx="${cx}" cy="${cy + r + 22}" rx="${r * 0.8}" ry="5" fill="#000" opacity=".14"/>` +
    `<g class="puff-body">` +
    `<path class="puff-tail" d="M${tl + 6} ${cy} L${tl - 22} ${cy - 16} Q${tl - 14} ${cy} ${tl - 22} ${cy + 16}Z" fill="#F2A91F"/>` +
    spikes +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${uid}B)"/>` +
    `<ellipse cx="${cx + 4}" cy="${cy + r * 0.42}" rx="${r * 0.68}" ry="${r * 0.44}" fill="url(#${uid}W)"/>` +
    [0, 1, 2].map(i => `<circle cx="${cx - r * 0.35 + i * r * 0.32}" cy="${cy - r * 0.6 + (i % 2) * 6}" r="${2.5 + p * 1.5}" fill="#D98C0F" opacity=".55"/>`).join('') +
    `<ellipse cx="${cx - r * 0.35}" cy="${cy - r * 0.5}" rx="${r * 0.28}" ry="${r * 0.16}" fill="#fff" opacity=".45" transform="rotate(-25 ${cx - r * 0.35} ${cy - r * 0.5})"/>` +
    // pectoral fin sits behind the eye on his side, pointing back (he faces right)
    `<path class="puff-fin" d="M${cx - r * 0.3} ${cy + r * 0.12} q-12 -9 -19 5 q11 -1 19 -5z" fill="#F2A91F" opacity=".9"/>` +
    `<g class="puff-eyes">${eye(cx + r * 0.18, cy - r * 0.12, 9 + p * 2, 2)}${eye(cx + r * 0.62, cy - r * 0.14, 8 + p * 2, 2)}</g>` +
    `<ellipse cx="${cx + r * 0.08}" cy="${cy + r * 0.12}" rx="6" ry="3.5" fill="#FF8FA3" opacity=".55"/>` +
    `<ellipse cx="${cx + r * 0.8}" cy="${cy + r * 0.1}" rx="5" ry="3" fill="#FF8FA3" opacity=".55"/>` +
    mouth + `</g></svg>`;
}
