// ==UserScript==
// @name         Politiko — People Watch
// @namespace    https://github.com/dataterminals/politiko-people-watch
// @version      1.1.0
// @description  Builds a local ledger of players' last-online times, ranks and combat records from the profiles you open, and sorts it least-active-first. Fully passive: it reads responses the game already made and originates nothing. Includes a next/back walk so filling the ledger by hand is one keypress per player.
// @author       dataterminals
// @homepageURL  https://github.com/dataterminals/politiko-people-watch
// @supportURL   https://github.com/dataterminals/politiko-people-watch/issues
// @updateURL    https://raw.githubusercontent.com/dataterminals/politiko-people-watch/main/people-watch.user.js
// @downloadURL  https://raw.githubusercontent.com/dataterminals/politiko-people-watch/main/people-watch.user.js
// @match        https://politiko.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * DISCLOSURE (Politiko rules, Scripting Abuse clause)
 *
 *   Reads:    JSON bodies of /api/* responses via a passive fetch/XHR tap — only the
 *             ones the game requested on its own, on pages you are actively viewing.
 *             Specifically /api/people (roster pages) and /api/users/<name> (profiles).
 *             No DOM scraping.
 *
 *   Requests: ZERO. This script does not originate network calls to politiko.io.
 *
 *             Clicking a name in the panel, or a walk button, is navigation — not a
 *             request this script originates. It performs the same client-side route
 *             change as clicking that player anywhere else in the game, and the app
 *             then fetches the profile as it always would, once, because you clicked.
 *             Nothing is queued, paced, retried, or continued in the background.
 *
 *   Sends:    nothing, to anyone, ever. No telemetry, no remote config, no export
 *             off-machine. Everything stays in this browser.
 *
 *   Storage:  localStorage keys prefixed `pkpw:` — the observed player ledger, roster
 *             metadata, and panel settings. All local. Clearable from the panel.
 *
 *   Alerts:   none. No notifications, no title flashing, no sound.
 *
 *   Personal data: the ledger holds other players' usernames and public profile fields.
 *             It never leaves this browser and must never be committed — artifacts/ and
 *             anything session-derived are gitignored for exactly this reason.
 *
 * HISTORY, stated plainly because the file used to say otherwise: versions up to 0.4.0
 * shipped an opt-in crawler that originated paced requests to /api/people and
 * /api/users/<name> to fill the ledger automatically. That is prohibited by the
 * scripting clause — items 2 and 5, penalty game ban — and it was carried as a
 * knowingly accepted risk from 2026-07-28. It is gone as of 1.0.0: the arming system,
 * the queue, the pacing and the request-originating code have all been removed rather
 * than disabled. What replaces it is the walk, which is just you pressing a key.
 */

(() => {
  'use strict';

  const TAG = '[pkpw]';
  const log = (...a) => console.debug(TAG, ...a);

  // ===========================================================================
  // Config
  // ===========================================================================
  const CFG = {
    // A profile whose whole lifetime was shorter than this never really engaged.
    NEVER_STUCK_MS: 2 * 3600_000,

    // `is_online` is a claim about *now* made from an observation taken whenever you
    // last opened that profile. It is only worth anything while that observation is
    // fresh — past this, someone "online" is just someone who was online once.
    LIVE_TRUST_MS: 5 * 60_000,

    HOTKEY: 'p',                // Alt+P toggles the panel
    WALK_PREV: '[',             // on a profile page, step back through the roster
    WALK_NEXT: ']',             // ...and forward
    PANEL_W: 560,
    PANEL_MIN_H: 160,
    FAB_SIZE: 42,           // a triangle carries less visual weight than a square of the same box
    EDGE: 8,                    // keep this much gap from the viewport edge
  };

  const K = {
    people: 'pkpw:people',
    roster: 'pkpw:roster',
    ui: 'pkpw:ui',
  };

  // ===========================================================================
  // Storage
  // ===========================================================================
  const readJSON = (k, fallback) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  };
  const writeJSON = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { log('save failed', k, e); }
  };

  /** @type {Record<string, any>} username -> observed profile */
  let people = readJSON(K.people, {});
  let roster = readJSON(K.roster, { total: null, totalPages: null, usernames: [], seenAt: 0, pages: {} });
  let ui = readJSON(K.ui, { sort: 'idle', dir: 1, hideOnline: false, hideNpc: true, minIdleDays: 0, open: false, fab: null, panel: null });
  if (ui.dir !== -1) ui.dir = 1;   // an older stored ui has no dir at all

  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      writeJSON(K.people, people);
      writeJSON(K.roster, roster);
      writeJSON(K.ui, ui);
    }, 1_000);
  };
  const saveNow = () => { clearTimeout(saveTimer); writeJSON(K.people, people); writeJSON(K.roster, roster); writeJSON(K.ui, ui); };

  // ===========================================================================
  // Ingest — every record here came off a response the game made on its own.
  // ===========================================================================
  const ingestRosterPage = (url, data) => {
    if (!data || !Array.isArray(data.people)) return;
    const page = Number(data.page) || null;
    roster.total = Number(data.total) || roster.total;
    roster.totalPages = Number(data.total_pages) || roster.totalPages;
    roster.seenAt = Date.now();
    if (page) roster.pages[page] = Date.now();

    for (const r of data.people) {
      if (!r || typeof r.username !== 'string') continue;
      if (!roster.usernames.includes(r.username)) roster.usernames.push(r.username);
      const cur = people[r.username] || {};
      people[r.username] = {
        ...cur,
        username: r.username,
        status: r.status ?? cur.status ?? null,
        in_city: r.in_city ?? cur.in_city ?? null,
        rosterSeenAt: Date.now(),
      };
    }
    log('roster page', page, 'of', roster.totalPages, '—', roster.usernames.length, 'known');
    save(); paint();
  };

  const ingestProfile = (url, data) => {
    if (!data || typeof data.username !== 'string' || !('last_online' in data)) return;
    const cur = people[data.username] || {};
    people[data.username] = {
      ...cur,
      username: data.username,
      status: data.status ?? null,
      last_online: data.last_online ?? null,
      is_online: !!data.is_online,
      created_at: data.created_at ?? null,
      rank_key: data.rank_key ?? null,
      is_npc: !!data.is_npc,
      age: data.age ?? null,
      combat: data.combat_record ? { ...data.combat_record } : (cur.combat ?? null),
      relationship: data.relationship ? { ...data.relationship } : (cur.relationship ?? null),
      observedAt: Date.now(),
    };
    if (!roster.usernames.includes(data.username)) roster.usernames.push(data.username);
    log('profile', data.username);
    save(); paint();
  };

  // ===========================================================================
  // Passive tap — reads responses already in flight. Adds no requests itself.
  // ===========================================================================
  const route = (u) => {
    try { return new URL(u, location.origin).pathname + new URL(u, location.origin).search; }
    catch { return String(u); }
  };

  const dispatch = (url, data) => {
    const p = route(url);
    if (/\/api\/people(\?|$)/.test(p)) ingestRosterPage(url, data);
    else if (/\/api\/users\/[^/]+$/.test(p)) ingestProfile(url, data);
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
      if (url.includes('/api/') && (res.headers.get('content-type') || '').includes('json')) {
        res.clone().json().then((d) => dispatch(url, d), () => {});
      }
    } catch (e) { log('fetch tap', e); }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__pkpwUrl = u;
    return origOpen.call(this, m, u, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try {
        const u = this.__pkpwUrl || '';
        if (u.includes('/api/') && (this.getResponseHeader('content-type') || '').includes('json')) {
          dispatch(u, JSON.parse(this.responseText));
        }
      } catch { /* not json */ }
    });
    return origSend.apply(this, a);
  };

  // ===========================================================================
  // Roster walk — the manual replacement for a crawler.
  //
  // The ledger only ever learns a player from a response the game itself made, so
  // somebody has to open the profiles. These step you along the roster you have
  // already enumerated, which turns a walk into one keypress per player instead of
  // a trip back to the People tab between each one.
  //
  // Every step is a navigation you asked for. The app fetches that profile exactly
  // as it would if you had clicked the player yourself, and nothing here is timed,
  // queued, or continued while you are looking at something else.
  // ===========================================================================
  const PROFILE_RE = /^\/profile\/([^/]+)$/;
  const mod = (n, m) => ((n % m) + m) % m;

  const currentProfile = () => {
    const m = PROFILE_RE.exec(location.pathname);
    try { return m ? decodeURIComponent(m[1]) : null; } catch { return m ? m[1] : null; }
  };

  /** roster order — the order the game itself paginated them in */
  const walkOrder = () => roster.usernames;

  const goProfile = (name) => {
    if (!name) return;
    history.pushState({}, '', `/profile/${encodeURIComponent(name)}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    paint();
  };

  /** one place along the roster from whoever is on screen; wraps at the ends */
  const step = (dir) => {
    const order = walkOrder();
    if (!order.length) return null;
    const i = order.indexOf(currentProfile());
    return i < 0 ? order[0] : order[mod(i + dir, order.length)];
  };

  /** the next player with no profile yet — the only ones a walk actually gains from */
  const nextUnseen = (dir = 1) => {
    const order = walkOrder();
    if (!order.length) return null;
    const start = Math.max(0, order.indexOf(currentProfile()));
    for (let k = 1; k <= order.length; k++) {
      const cand = order[mod(start + dir * k, order.length)];
      if (!people[cand]?.observedAt) return cand;
    }
    return null;
  };

  // ===========================================================================
  // Derived metrics
  // ===========================================================================
  const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

  function derive(r) {
    const last = ms(r.last_online);
    const made = ms(r.created_at);
    const idleMs = last ? Date.now() - last : null;
    const lifetimeMs = last && made ? last - made : null;
    const staleMs = r.observedAt ? Date.now() - r.observedAt : null;
    const live = liveScore(r, staleMs, idleMs);
    const c = r.combat || {};
    const won = c.attacks_won ?? 0;
    const lost = c.attacks_lost ?? 0;
    return {
      idleMs,
      idleDays: idleMs == null ? null : idleMs / 86_400_000,
      neverStuck: lifetimeMs != null && lifetimeMs < CFG.NEVER_STUCK_MS,
      lifetimeMs,
      won, lost,
      record: `${won}-${lost}`,
      staleMs,
      live,
      liveNow: live === 3,
    };
  }

  /**
   * How much the ledger can say about someone being active *right now*, which is not
   * something it can ever really know — every field here was true when you looked, and
   * nothing refreshes on its own.
   *
   *   3  seen online, and seen recently enough to still mean it
   *   2  seen online, but a while ago — no evidence about now
   *   1  not flagged online, but their last_online is within minutes of now
   *   0  nothing suggesting activity
   */
  function liveScore(r, staleMs, idleMs) {
    if (r.is_online && staleMs != null && staleMs <= CFG.LIVE_TRUST_MS) return 3;
    if (r.is_online) return 2;
    if (idleMs != null && idleMs <= CFG.LIVE_TRUST_MS) return 1;
    return 0;
  }

  const fmtDur = (msv) => {
    if (msv == null) return '—';
    const s = Math.floor(msv / 1000);
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    const d = Math.floor(s / 86400);
    return d < 365 ? `${d}d` : `${(d / 365).toFixed(1)}y`;
  };

  /**
   * Every sort is written so its *natural* order matches its label — "most idle" puts
   * the most idle first. `ui.dir === -1` reverses whatever that was, which keeps one
   * toggle meaningful across columns that don't share a direction (A→Z is ascending,
   * most-idle-first is descending, and both are "natural" for their label).
   *
   * `col` is the table column the sort belongs to, so clicking a header and picking
   * from the dropdown drive the same state.
   */
  const SORTS = {
    idle: {
      label: 'most idle', col: 'idle',
      cmp: (a, b) => (b.d.idleMs ?? -1) - (a.d.idleMs ?? -1),
    },
    live: {
      label: 'active now', col: 'idle',
      // ranked by how much the ledger can actually claim, then by recency within that
      cmp: (a, b) => (b.d.live - a.d.live) || ((a.d.idleMs ?? Infinity) - (b.d.idleMs ?? Infinity)),
    },
    record: {
      label: 'worst record', col: 'record',
      cmp: (a, b) => (b.d.lost - b.d.won) - (a.d.lost - a.d.won),
    },
    fresh: {
      label: 'freshest data', col: 'seen',
      cmp: (a, b) => (a.d.staleMs ?? 0) - (b.d.staleMs ?? 0),
    },
    rank: {
      label: 'rank', col: 'rank',
      cmp: (a, b) => String(a.r.rank_key ?? '').localeCompare(String(b.r.rank_key ?? '')),
    },
    name: {
      label: 'name', col: 'player',
      cmp: (a, b) => a.r.username.localeCompare(b.r.username),
    },
  };

  const COLUMNS = [
    { key: 'player', label: 'player', sort: 'name' },
    { key: 'idle', label: 'idle', sort: 'idle' },
    { key: 'rank', label: 'rank', sort: 'rank' },
    { key: 'record', label: 'W-L', sort: 'record' },
    { key: 'seen', label: 'seen', sort: 'fresh' },
  ];

  function rows() {
    const out = [];
    for (const u of Object.keys(people)) {
      const r = people[u];
      if (!r.observedAt) continue;           // roster-only, nothing to rank yet
      const d = derive(r);
      if (ui.hideNpc && r.is_npc) continue;
      if (ui.hideOnline && r.is_online) continue;
      if (ui.minIdleDays && (d.idleDays ?? 0) < ui.minIdleDays) continue;
      out.push({ r, d });
    }
    const cmp = (SORTS[ui.sort] || SORTS.idle).cmp;
    out.sort(cmp);
    if (ui.dir === -1) out.reverse();
    return out;
  }

  // ===========================================================================
  // Panel
  // ===========================================================================
  let host = null, root = null, fab = null;
  let grip = null, gripCov = null, panelDrag = null;

  // ===========================================================================
  // PANEL KIT v1 — shared verbatim block.
  //
  //    Repo convention: every panel we ship is draggable and remembers where you
  //    put it. Copy this block into a new tool exactly as it stands. If you have
  //    to change it, bump the version in this header and in every tool carrying
  //    a copy, so the copies can be diffed. No build step, no @require, so each
  //    script stays a single auditable file (clause 6).
  //
  //    draggable(node, handle, onMove) -> { apply(pos), reset(), dragged() }
  //      node    the element that moves (must be position: fixed)
  //      handle  the grab area; buttons/inputs inside it stay clickable, unless
  //              the handle IS the control (a bare FAB drags from itself)
  //      onMove  called with {x, y} in viewport px, or null when reset
  //      dragged() is true if the last gesture actually moved — check it in a
  //              click handler so dragging a FAB doesn't also toggle it
  // ===========================================================================
  const draggable = (node, handle, onMove) => {
    const EDGE = 44; // px of the element that must stay reachable on screen
    let sx = 0, sy = 0, ox = 0, oy = 0, live = false, moved = false;
    let skew = null; // gap between the border box and what left/top actually set

    const place = (x, y) => {
      const w = node.offsetWidth, h = node.offsetHeight;
      const p = w && h ? {
        x: Math.min(Math.max(x, EDGE - w), window.innerWidth - EDGE),
        y: Math.min(Math.max(y, 0), window.innerHeight - Math.min(EDGE, h)),
      } : { x, y }; // hidden element: no geometry to clamp against, fix it on show
      node.style.left = `${p.x}px`;
      node.style.top = `${p.y}px`;
      node.style.right = 'auto';
      node.style.bottom = 'auto';
      // `left` positions the MARGIN edge, but every measurement here is the
      // border box. If the host page styles our element with a margin, each grab
      // drifts by that much and compounds. Measure the gap once, then cancel it.
      if (skew === null && w && h) {
        const seen = node.getBoundingClientRect();
        skew = { x: seen.left - p.x, y: seen.top - p.y };
      }
      if (skew && (skew.x || skew.y)) {
        node.style.left = `${p.x - skew.x}px`;
        node.style.top = `${p.y - skew.y}px`;
      }
      return p;
    };

    const down = (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      // a control inside the handle keeps its click; the handle itself still drags
      if (ev.target !== handle && ev.target.closest?.('button,input,select,textarea,a,[data-nodrag]')) return;
      const r = node.getBoundingClientRect();
      place(r.left, r.top); // convert whatever CSS anchoring it had into left/top
      sx = ev.clientX; sy = ev.clientY; ox = r.left; oy = r.top;
      live = true; moved = false;
      try { handle.setPointerCapture(ev.pointerId); } catch { /* capture is a nicety */ }
      ev.preventDefault();
    };

    const move = (ev) => {
      if (!live) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return; // tremor isn't a drag
      moved = true;
      place(ox + dx, oy + dy);
    };

    const up = (ev) => {
      if (!live) return;
      live = false;
      try { handle.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
      if (!moved) return;
      const r = node.getBoundingClientRect();
      onMove({ x: r.left, y: r.top });
    };

    handle.style.touchAction = 'none'; // don't scroll the game while dragging
    handle.style.cursor = 'grab';
    handle.addEventListener('pointerdown', down);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);

    // Never strand the panel: a short window, a rotation, or a panel that grew
    // taller than the space its CSS corner left it can all put the drag handle
    // off-screen, and then there is no way to get it back.
    const fit = () => {
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const x = Math.min(Math.max(r.left, EDGE - r.width), window.innerWidth - EDGE);
      const y = Math.min(Math.max(r.top, 0), window.innerHeight - Math.min(EDGE, r.height));
      if (Math.abs(x - r.left) < 0.5 && Math.abs(y - r.top) < 0.5) return false;
      onMove(place(x, y));
      return true;
    };
    window.addEventListener('resize', fit);

    return {
      apply: (pos) => {
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false;
        place(pos.x, pos.y);
        return true;
      },
      reset: () => {
        node.style.left = node.style.top = node.style.right = node.style.bottom = '';
        onMove(null);
      },
      dragged: () => moved,
      fit, // call after mounting and after any render that changes the size
    };
  };

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-monospace, Menlo, Consolas, monospace; }
    .panel { position: fixed; z-index: 2147483000; background: #09090b; color: #e4e4e7;
      border: 1px solid #27272a; width: ${CFG.PANEL_W}px; max-height: 70vh; display: flex;
      flex-direction: column; font-size: 12px; }
    .bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid #27272a; flex-wrap: wrap; }
    .bar b { font-weight: 600; letter-spacing: .04em; }
    .spacer { flex: 1; }
    button, select { background: #18181b; color: #e4e4e7; border: 1px solid #3f3f46;
      padding: 2px 7px; font-size: 11px; cursor: pointer; font-family: inherit; }
    button:hover { background: #27272a; }
    button.on { background: #dc2626; border-color: #dc2626; color: #fff; }
    button.dry { background: #ca8a04; border-color: #ca8a04; color: #000; }
    .body { overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #18181b; white-space: nowrap; }
    th { position: sticky; top: 0; background: #09090b; color: #a1a1aa; font-weight: 500; font-size: 11px; }
    tr:hover td { background: #18181b; }
    a.plink { color: inherit; text-decoration: none; cursor: pointer;
      border-bottom: 1px dotted #3f3f46; }
    a.plink:hover { color: #fafafa; border-bottom-color: #a1a1aa; }
    th.sortable { cursor: pointer; user-select: none; }
    th.sortable:hover { color: #e4e4e7; }
    th.sorted { color: #fafafa; }
    .live { color: #4ade80; }
    .idle { color: #f87171; }
    .never { color: #fbbf24; }
    .dim { color: #71717a; }
    .note { padding: 6px 8px; color: #a1a1aa; border-top: 1px solid #27272a; font-size: 11px; }
    /* The button is the triangle — not a square with a triangle drawn on it. The
       outline and fill come from the SVG, and clip-path takes the corners out of the
       box itself, so the hit area is the triangle too: clicks in the dead corners
       fall through to whatever is underneath. */
    .fab { position: fixed; z-index: 2147483000; width: ${CFG.FAB_SIZE}px; height: ${CFG.FAB_SIZE}px;
      background: none; border: 0; padding: 0; color: #e4e4e7;
      cursor: grab; touch-action: none; display: block;
      clip-path: polygon(50% 0%, 100% 100%, 0% 100%); }
    .fab svg { width: 100%; height: 100%; display: block; }
    .fab:hover { color: #fafafa; }
    .fab.dragging { cursor: grabbing; color: #a1a1aa; }
    .grip { display: flex; gap: 8px; align-items: baseline; padding: 6px 8px;
      border-bottom: 1px solid #27272a; user-select: none; }
    .grip b { font-weight: 600; letter-spacing: .04em; }
    .grip .cov { margin-left: auto; }
  `;

  // The eye of providence. The triangle carries the button's own fill and outline and
  // runs to the edge of the box, inset just enough that its stroke survives the
  // clip-path rather than being sliced in half along the diagonals.
  const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
      <path d="M12 2 22.6 22.2 1.4 22.2 Z" fill="#09090b"/>
      <path d="M7.3 16.5c1.5-2.6 7.9-2.6 9.4 0-1.5 2.6-7.9 2.6-9.4 0Z"/>
      <circle cx="12" cy="16.5" r="1.45" fill="currentColor" stroke="none"/>
    </svg>`;

  function mount() {
    if (host) return;
    host = document.createElement('div');
    // The host must carry the z-index, not just the children. position:fixed makes it a
    // stacking context, so the huge z-indexes inside are only ever resolved against each
    // other — left on `auto` the whole shadow tree sits below the game's Comms dock
    // (z-index 9999) and clicks on the overlap land on chat instead of on us.
    host.style.cssText = 'position:fixed;inset:0;width:0;height:0;z-index:2147483000;';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
    document.documentElement.append(host);

    fab = document.createElement('button');
    fab.className = 'fab';
    fab.innerHTML = EYE_SVG;
    fab.setAttribute('aria-label', 'People Watch');
    fab.title = 'People Watch — click to open, drag to move, double-click to reset';
    root.append(fab);

    const panel = document.createElement('div');
    panel.className = 'panel';

    // The drag handle has to outlive paint(), which rebuilds everything below it.
    grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to move · double-click to re-tether to the button';
    gripCov = document.createElement('span');
    gripCov.className = 'dim cov';
    grip.append(Object.assign(document.createElement('b'), { textContent: 'PEOPLE WATCH' }), gripCov);
    panel.append(grip);

    root.append(panel);

    // Park it where you like; until you do, it stays tethered to the button.
    panelDrag = draggable(panel, grip, (pos) => { ui.panel = pos; saveNow(); if (!pos) placePanel(); });
    grip.addEventListener('dblclick', () => panelDrag.reset());

    placeFab();
    makeDraggable();
    window.addEventListener('resize', placeFab);
    paint();
  }

  // ---------------------------------------------------------------------------
  // Placement — the button is draggable and the position is remembered, because
  // the game's own furniture (the chat dock) owns the bottom-right corner and
  // there is no arrangement that is right for every layout. The panel hangs off
  // whichever side of the button has room, so it can't end up off-screen.
  // ---------------------------------------------------------------------------
  // Right edge, but in the upper third rather than dead centre: the Comms dock is
  // 420px tall and anchored to the bottom of the same edge, so a vertically centred
  // button lands on top of it on any window shorter than ~840px.
  const defaultFabPos = () => ({
    x: window.innerWidth - CFG.FAB_SIZE - CFG.EDGE,
    y: Math.round(window.innerHeight * 0.28),
  });

  const clampFab = ({ x, y }) => ({
    x: Math.min(Math.max(x, CFG.EDGE), Math.max(CFG.EDGE, window.innerWidth - CFG.FAB_SIZE - CFG.EDGE)),
    y: Math.min(Math.max(y, CFG.EDGE), Math.max(CFG.EDGE, window.innerHeight - CFG.FAB_SIZE - CFG.EDGE)),
  });

  /**
   * A hidden tab or a minimised window can report a ~zero viewport. Clamping
   * against that pins everything into the top-left corner and the next save
   * makes it permanent, so treat it as "no information" and leave the stored
   * position alone until real dimensions come back.
   */
  const viewportUsable = () => window.innerWidth > 120 && window.innerHeight > 120;

  function placeFab() {
    if (!fab || !viewportUsable()) return;
    ui.fab = clampFab(ui.fab || defaultFabPos());
    Object.assign(fab.style, {
      left: `${ui.fab.x}px`, top: `${ui.fab.y}px`, right: 'auto', bottom: 'auto',
    });
    placePanel();
  }

  // Which side of the button the panel is currently hanging off. Sticky, so it
  // doesn't flip back and forth while the button is being dragged along an edge.
  let panelAlign = 'right';

  function placePanel() {
    const panel = root && root.querySelector('.panel');
    if (!panel || !ui.fab || !viewportUsable()) return;
    const { x, y } = ui.fab;
    const gap = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(CFG.PANEL_W, vw - CFG.EDGE * 2);
    panel.style.width = `${w}px`;

    // Parked by hand: the panel keeps its own spot and stops following the button.
    // Height is capped to whatever is left below it so the table scrolls instead of
    // running off the bottom. Double-click the header to hand it back to the tether.
    if (ui.panel) {
      panel.style.left = `${ui.panel.x}px`;
      panel.style.top = `${ui.panel.y}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.maxHeight = `${Math.max(CFG.PANEL_MIN_H, vh - ui.panel.y - CFG.EDGE)}px`;
      panelDrag?.fit();
      return;
    }

    // Horizontal: whichever edge of the button leaves the panel fully on screen,
    // preferring right-aligned so it opens inward from the right.
    const rightAligned = x + CFG.FAB_SIZE - w;
    const leftAligned = x;
    const fits = (l) => l >= CFG.EDGE && l + w <= vw - CFG.EDGE;

    let left;
    if (panelAlign === 'left' && fits(leftAligned)) left = leftAligned;
    else if (fits(rightAligned)) { left = rightAligned; panelAlign = 'right'; }
    else if (fits(leftAligned)) { left = leftAligned; panelAlign = 'left'; }
    else { left = rightAligned; panelAlign = 'right'; }
    panel.style.left = `${Math.max(CFG.EDGE, Math.min(left, vw - w - CFG.EDGE))}px`;
    panel.style.right = 'auto';

    // Vertical: whichever side of the button has more room, capped to exactly
    // that much so the table scrolls instead of overflowing the viewport.
    const above = y - gap - CFG.EDGE;
    const below = vh - (y + CFG.FAB_SIZE) - gap - CFG.EDGE;
    if (above >= below) {
      panel.style.bottom = `${vh - y + gap}px`;
      panel.style.top = 'auto';
    } else {
      panel.style.top = `${y + CFG.FAB_SIZE + gap}px`;
      panel.style.bottom = 'auto';
    }
    panel.style.maxHeight = `${Math.max(CFG.PANEL_MIN_H, Math.max(above, below))}px`;
  }

  function makeDraggable() {
    let drag = null;
    let suppressClick = false;

    fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = ui.fab || (ui.fab = clampFab(defaultFabPos()));
      drag = { dx: e.clientX - p.x, dy: e.clientY - p.y, id: e.pointerId, moved: false };
      try { fab.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
      e.preventDefault();
    });

    fab.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const nx = e.clientX - drag.dx, ny = e.clientY - drag.dy;
      // A few px of slop, so a slightly shaky click still counts as a click.
      if (!drag.moved && Math.hypot(nx - ui.fab.x, ny - ui.fab.y) < 4) return;
      if (!drag.moved) { drag.moved = true; fab.classList.add('dragging'); }
      ui.fab = clampFab({ x: nx, y: ny });
      placeFab();
    });

    const end = (e) => {
      if (!drag || (e.pointerId != null && e.pointerId !== drag.id)) return;
      const moved = drag.moved;
      drag = null;
      fab.classList.remove('dragging');
      try { fab.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (moved) { suppressClick = true; save(); }
    };
    fab.addEventListener('pointerup', end);
    fab.addEventListener('pointercancel', end);

    // Click still drives the toggle, so the keyboard path keeps working; a drag
    // just swallows the click that follows it.
    fab.onclick = () => {
      if (suppressClick) { suppressClick = false; return; }
      ui.open = !ui.open; save(); paint();
    };

    // Double-click returns it to the default spot if it ever gets lost.
    fab.ondblclick = () => { ui.fab = defaultFabPos(); save(); placeFab(); };
  }

  /**
   * A real <a href>, so middle-click and ctrl-click open a tab the way they should and
   * the browser shows the destination on hover. A plain left click is intercepted and
   * turned into the SPA route change instead, because a full page load would throw away
   * the whole session's in-memory state for no reason.
   *
   * This is navigation, not a request we originate: it is the same thing clicking that
   * player anywhere else in the game does. The app fetches the profile itself, exactly
   * as it always would, and the tap ingests that response like any other.
   */
  const profileLink = (username) => {
    const a = document.createElement('a');
    a.className = 'plink';
    a.textContent = username;
    a.href = `/profile/${encodeURIComponent(username)}`;
    a.title = `open @${username}'s profile`;
    a.addEventListener('click', (e) => {
      // let the browser handle anything that isn't a plain left click
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      history.pushState({}, '', a.getAttribute('href'));
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    return a;
  };

  function paint() {
    if (!root) return;
    const panel = root.querySelector('.panel');
    if (!panel) return;
    panel.style.display = ui.open ? 'flex' : 'none';
    if (!ui.open) return;

    const list = rows();
    const known = roster.usernames.length;
    const withProfile = Object.values(people).filter((r) => r.observedAt).length;
    const total = roster.total ?? '?';

    // keep the grip: it carries the drag listeners, everything below it is disposable
    panel.replaceChildren(grip);
    gripCov.textContent = `${withProfile}/${total} profiled · ${known} known`;

    // The walk bar, only while you are standing on a profile.
    const here = currentProfile();
    if (here) {
      const order = walkOrder();
      const idx = order.indexOf(here);
      const unseen = order.filter((u) => !people[u]?.observedAt).length;

      const bar = document.createElement('div');
      bar.className = 'bar';

      const jump = (label, name, hint) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = name ? `${hint} — @${name}` : hint;
        b.disabled = !name;
        b.onclick = () => goProfile(name);
        return b;
      };

      bar.append(jump(`‹ ${CFG.WALK_PREV}`, step(-1), 'previous player in the roster'));
      bar.append(jump(`${CFG.WALK_NEXT} ›`, step(1), 'next player in the roster'));
      bar.append(jump('next unseen ›', nextUnseen(), 'skip ahead to a player with no profile yet'));

      const where = document.createElement('span');
      where.className = 'dim';
      where.textContent = idx >= 0
        ? `${idx + 1}/${order.length} · ${unseen} unseen`
        : `@${here} is not in the roster yet · ${unseen} unseen`;
      bar.append(where);

      panel.append(bar);
    }

    const bar2 = document.createElement('div');
    bar2.className = 'bar';
    const sortSel = document.createElement('select');
    for (const [v, s] of Object.entries(SORTS)) sortSel.append(new Option(s.label, v));
    sortSel.value = ui.sort;
    sortSel.onchange = () => { ui.sort = sortSel.value; save(); paint(); };
    bar2.append(sortSel);

    const rev = document.createElement('button');
    rev.textContent = ui.dir === -1 ? '↑ reversed' : '↓ normal';
    rev.title = 'flip the order of whatever is selected';
    if (ui.dir === -1) rev.className = 'on';
    rev.onclick = () => { ui.dir = ui.dir === -1 ? 1 : -1; save(); paint(); };
    bar2.append(rev);

    const mk = (label, key) => {
      const b = document.createElement('button');
      b.textContent = `${ui[key] ? '☑' : '☐'} ${label}`;
      b.onclick = () => { ui[key] = !ui[key]; save(); paint(); };
      return b;
    };
    bar2.append(mk('hide npc', 'hideNpc'), mk('hide online', 'hideOnline'));

    const minSel = document.createElement('select');
    for (const d of [0, 1, 3, 7, 14, 30]) minSel.append(new Option(d ? `≥${d}d idle` : 'any idle', String(d)));
    minSel.value = String(ui.minIdleDays || 0);
    minSel.onchange = () => { ui.minIdleDays = Number(minSel.value); save(); paint(); };
    bar2.append(minSel);
    panel.append(bar2);

    const body = document.createElement('div');
    body.className = 'body';
    const table = document.createElement('table');
    // Clicking a header sorts by it; clicking the one already sorted flips the order.
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    const activeCol = (SORTS[ui.sort] || SORTS.idle).col;
    for (const c of COLUMNS) {
      const th = document.createElement('th');
      th.className = 'sortable';
      const on = c.key === activeCol;
      th.textContent = c.label + (on ? (ui.dir === -1 ? ' ▲' : ' ▼') : '');
      if (on) th.classList.add('sorted');
      th.title = on ? 'click to reverse' : `sort by ${SORTS[c.sort].label}`;
      th.onclick = () => {
        if (c.key === activeCol) ui.dir = ui.dir === -1 ? 1 : -1;
        else { ui.sort = c.sort; ui.dir = 1; }
        save(); paint();
      };
      htr.append(th);
    }
    thead.append(htr);
    table.append(thead);
    const tb = document.createElement('tbody');
    for (const { r, d } of list.slice(0, 400)) {
      const tr = document.createElement('tr');
      const cells = [
        r.username + (d.neverStuck ? ' ◦' : ''),
        d.liveNow ? '● online' : fmtDur(d.idleMs),
        r.rank_key || '—',
        d.record,
        fmtDur(d.staleMs),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 0) td.append(profileLink(r.username), document.createTextNode(d.neverStuck ? ' ◦' : ''));
        else td.textContent = c;
        if (i === 0 && d.neverStuck) td.className = 'never';
        // only claim "online" where the observation is fresh enough to support it;
        // a stale online flag is shown as plain idle time instead of a green light
        if (i === 1) td.className = d.liveNow ? 'live' : 'idle';
        if (i === 4) td.className = 'dim';
        tr.append(td);
      });
      tb.append(tr);
    }
    table.append(tb);
    body.append(table);
    panel.append(body);

    const note = document.createElement('div');
    note.className = 'note';
    const unseen = roster.usernames.filter((u) => !people[u]?.observedAt).length;
    note.textContent = `passive · ${unseen} known player(s) still unprofiled`
      + ` · open one to record it · ◦ = never stuck`;
    panel.append(note);

    // the rows just changed the height, so re-place and re-check it is still reachable
    placePanel();
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  const typing = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

  const boot = () => {
    mount();
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.toLowerCase() === CFG.HOTKEY) { ui.open = !ui.open; save(); paint(); return; }
      // walk keys work whether or not the panel is open, but never while you are
      // typing — the game has a chat box and swallowing a bracket would be rude
      if (e.altKey || e.ctrlKey || e.metaKey || typing(e.target) || !currentProfile()) return;
      if (e.key === CFG.WALK_PREV) { e.preventDefault(); goProfile(step(-1)); }
      else if (e.key === CFG.WALK_NEXT) { e.preventDefault(); goProfile(step(1)); }
    });
    // the walk bar only exists on profile routes, so repaint when the route moves
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function (...a) { const r = orig.apply(this, a); queueMicrotask(paint); return r; };
    }
    window.addEventListener('popstate', () => queueMicrotask(paint));
    log('ready — passive ·', roster.usernames.length, 'known');
  };

  window.__pkpw = {
    people: () => people,
    roster: () => roster,
    rows,
    unseen: () => roster.usernames.filter((u) => !people[u]?.observedAt),
    resetFab: () => { ui.fab = defaultFabPos(); saveNow(); placeFab(); return ui.fab; },
    clear: () => { people = {}; roster = { total: null, totalPages: null, usernames: [], seenAt: 0, pages: {} }; saveNow(); paint(); return 'cleared'; },
    export: () => JSON.stringify({ people, roster }, null, 2),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
