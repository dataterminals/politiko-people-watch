// ==UserScript==
// @name         Politiko — People Watch
// @namespace    https://github.com/dataterminals/politiko-people-watch
// @version      0.4.0
// @description  Builds a local ledger of players' last-online times, ranks and combat records, and sorts it least-active-first. Reads profiles the app fetches on its own; when explicitly armed, ORIGINATES paced requests to /api/people and /api/users/{name} to fill the gaps.
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
 * READ THIS BEFORE SHARING THE FILE. Unlike every other tool in this repo, this one
 * is NOT passive when armed. It originates requests to politiko.io.
 *
 *   Reads:    JSON bodies of /api/* responses via a passive fetch/XHR tap — both the
 *             ones the app requested on its own and the ones this script requested.
 *             Specifically /api/people (roster pages) and /api/users/<name> (profiles).
 *             No DOM scraping.
 *
 *   Requests: ZERO while disarmed — the default on every load. Arming is a deliberate
 *             act with an expiry, and survives reload only until that expiry.
 *
 *             Clicking a name in the panel is navigation, not a request this script
 *             originates: it performs the same client-side route change as clicking
 *             that player anywhere else in the game, and the app then fetches the
 *             profile as it always would — only because you clicked.
 *
 *             WHEN ARMED IN 'live' MODE THIS SCRIPT ORIGINATES REQUESTS:
 *               GET /api/people?page=N   — up to `total_pages` (30 at time of writing)
 *               GET /api/users/<name>    — one per player (292 at time of writing)
 *             They are paced, jittered, foreground-only, capped per session, and stop
 *             dead on the first non-2xx. That reduces the footprint; it does not make
 *             the script passive. It is a crawl.
 *
 *             This is prohibited by Politiko's scripting clause — items 2 and 5,
 *             penalty: game ban. It is an accepted-risk decision taken knowingly on
 *             2026-07-28. Arm it understanding that, or leave it disarmed.
 *
 *   Sends:    nothing, to anyone, ever. No telemetry, no remote config, no export
 *             off-machine. Everything stays in this browser.
 *
 *   Storage:  localStorage keys prefixed `pkpw:` — the observed player ledger, roster
 *             metadata, backfill progress, and panel settings. All local. Clearable
 *             from the panel.
 *
 *   Alerts:   none. No notifications, no title flashing, no sound. The crawl pauses
 *             while the tab is hidden and resumes when it is focused again.
 *
 *   Personal data: the ledger holds other players' usernames and public profile fields.
 *             It never leaves this browser and must never be committed — artifacts/ and
 *             anything session-derived are gitignored for exactly this reason.
 */

(() => {
  'use strict';

  const TAG = '[pkpw]';
  const log = (...a) => console.debug(TAG, ...a);

  // ===========================================================================
  // Config
  // ===========================================================================
  const CFG = {
    // Pacing. A full sweep is ~322 requests; at 8s that is roughly 45 minutes.
    // Slower is safer. These are the knobs to turn if anything looks unwelcome.
    MIN_GAP_MS: 8_000,
    JITTER_MS: 4_000,           // added randomly on top of MIN_GAP, so it isn't a metronome
    MAX_REQUESTS_PER_SESSION: 500,  // backstop against a loop; reset on reload
    PAUSE_WHEN_HIDDEN: true,    // never crawl a tab you aren't looking at

    REFRESH_AFTER_MS: 12 * 3600_000,  // a profile older than this is eligible for re-fetch
    ROSTER_REFRESH_AFTER_MS: 6 * 3600_000,

    // A profile whose whole lifetime was shorter than this never really engaged.
    NEVER_STUCK_MS: 2 * 3600_000,

    DEFAULT_ARM_HOURS: 24,
    HOTKEY: 'p',                // Alt+P toggles the panel
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
  let ui = readJSON(K.ui, { arm: null, sort: 'idle', hideOnline: false, hideNpc: true, minIdleDays: 0, open: false, fab: null, panel: null });

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
  // Arming — persistent, expiring, off by default.
  //
  //   __pkpw.arm('dry')        build the queue and report it; send nothing
  //   __pkpw.arm('live')       originate requests (24h)
  //   __pkpw.arm('live', 2)    ...for the next 2 hours
  //   __pkpw.arm('live', 0)    ...with no expiry (discouraged)
  //   __pkpw.disarm()
  //
  // A crawler left armed because someone forgot is a worse failure than one that
  // needs re-arming, so expiry is the default and disarming is always immediate.
  // ===========================================================================
  const armMode = () => {
    const a = ui.arm;
    if (!a) return null;
    if (a.until && Date.now() > a.until) { ui.arm = null; save(); return null; }
    return a.mode;
  };
  const armState = () => {
    const m = armMode();
    return { mode: m || 'off', until: ui.arm?.until || null, requestsThisSession, cap: CFG.MAX_REQUESTS_PER_SESSION };
  };
  function arm(mode, hours = CFG.DEFAULT_ARM_HOURS) {
    if (mode !== 'dry' && mode !== 'live') {
      throw new Error("arm('dry'|'live', hours?) — 'dry' reports what it would fetch, 'live' fetches");
    }
    ui.arm = { mode, until: hours > 0 ? Date.now() + hours * 3600_000 : 0 };
    saveNow(); paint();
    if (mode === 'live') pump(); else dryReport();
    return armState();
  }
  function disarm() {
    ui.arm = null; stopReason = null;
    saveNow(); paint();
    return armState();
  }

  // ===========================================================================
  // Ingest — one path, whether the response was the app's or ours.
  // ===========================================================================
  const inFlightOurs = new Set();

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
    const via = inFlightOurs.has(url) ? 'backfill' : 'passive';
    inFlightOurs.delete(url);
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
      via,
    };
    if (!roster.usernames.includes(data.username)) roster.usernames.push(data.username);
    log('profile', data.username, `(${via})`);
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
  // Backfill — the part that originates requests. Armed only.
  // ===========================================================================
  let requestsThisSession = 0;
  let pumping = false;
  let stopReason = null;
  let nextTimer = null;

  // Jobs that came back 2xx but left no usable record — a shape we didn't expect, a
  // deleted account, whatever. Without this the queue re-serves the same job forever
  // and the crawler spins burning requests on it. Session-scoped: a reload retries.
  const blocked = new Set();
  const jobId = (j) => (j.kind === 'roster' ? `r:${j.page}` : `p:${j.username}`);
  const landed = (j) => (j.kind === 'roster'
    ? !!roster.pages[j.page]
    : !!people[j.username]?.observedAt);

  /** What still needs fetching, most valuable first. */
  function buildQueue() {
    const now = Date.now();
    const jobs = [];

    // 1. Roster pages we've never seen, or that have gone stale. Without these we
    //    don't even know who exists, so they come first.
    const tp = roster.totalPages;
    if (!tp) {
      jobs.push({ kind: 'roster', page: 1, why: 'roster never seen' });
    } else {
      for (let p = 1; p <= tp; p++) {
        const seen = roster.pages[p] || 0;
        if (now - seen > CFG.ROSTER_REFRESH_AFTER_MS) {
          jobs.push({ kind: 'roster', page: p, why: seen ? 'stale' : 'never seen' });
        }
      }
    }

    // 2. Known players with no profile yet.
    for (const u of roster.usernames) {
      const r = people[u];
      if (!r || !r.observedAt) jobs.push({ kind: 'profile', username: u, why: 'never fetched' });
    }

    // 3. Profiles that have aged out, oldest observation first.
    const stale = roster.usernames
      .map((u) => people[u])
      .filter((r) => r && r.observedAt && now - r.observedAt > CFG.REFRESH_AFTER_MS)
      .sort((a, b) => a.observedAt - b.observedAt);
    for (const r of stale) jobs.push({ kind: 'profile', username: r.username, why: 'stale' });

    return jobs.filter((j) => !blocked.has(jobId(j)));
  }

  const jitter = () => CFG.MIN_GAP_MS + Math.floor(Math.random() * CFG.JITTER_MS);

  /**
   * What a live run would do, without doing any of it. This is the whole point of
   * 'dry' — you get to see the size of the thing before firing it at a live account.
   */
  function dryReport() {
    const q = buildQueue();
    const pages = q.filter((j) => j.kind === 'roster').length;
    const never = q.filter((j) => j.kind === 'profile' && j.why === 'never fetched').length;
    const aged = q.filter((j) => j.kind === 'profile' && j.why === 'stale').length;
    const secs = (q.length * (CFG.MIN_GAP_MS + CFG.JITTER_MS / 2)) / 1000;

    console.group(`${TAG} DRY RUN — nothing sent`);
    if (!roster.totalPages) {
      console.warn(
        'Roster has never been enumerated, so the full sweep size is not knowable yet.\n' +
        'total/total_pages only arrive with roster page 1. Open the People tab once —\n' +
        'the passive tap reads it for free — or arm live and let job 1 discover it.',
      );
    }
    console.log(`queued now       ${q.length}`);
    console.log(`  roster pages   ${pages}`);
    console.log(`  new profiles   ${never}`);
    console.log(`  stale refresh  ${aged}`);
    if (roster.totalPages && roster.total) {
      console.log(`full sweep       ~${roster.totalPages + roster.total} requests once enumerated`);
    }
    console.log(`pacing           ${CFG.MIN_GAP_MS / 1000}s +0-${CFG.JITTER_MS / 1000}s jitter`);
    console.log(`est. wall clock  ~${Math.max(1, Math.round(secs / 60))} min for what is queued now`);
    console.log('first 10:', q.slice(0, 10).map((j) =>
      j.kind === 'roster' ? `GET /api/people?page=${j.page}` : `GET /api/users/${j.username}`));
    console.groupEnd();
    return { queued: q.length, rosterPages: pages, newProfiles: never, staleRefresh: aged };
  }

  async function runOne(job) {
    const url = job.kind === 'roster'
      ? `/api/people?page=${job.page}`
      : `/api/users/${encodeURIComponent(job.username)}`;

    if (armMode() === 'dry') { log('DRY — would GET', url, `(${job.why})`); return { ok: true, dry: true }; }

    requestsThisSession++;
    inFlightOurs.add(url);
    try {
      // same-origin, so the session cookie carries itself; no token is read or replayed
      const res = await origFetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!res.ok) return { ok: false, status: res.status };
      // The tap above does not see origFetch calls, so ingest here directly.
      const data = await res.json();
      dispatch(url, data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    } finally {
      inFlightOurs.delete(url);
    }
  }

  async function pump() {
    if (pumping) return;
    const mode = armMode();
    if (!mode) return;
    pumping = true;
    stopReason = null;

    try {
      while (armMode()) {
        if (CFG.PAUSE_WHEN_HIDDEN && document.hidden) { stopReason = 'paused — tab hidden'; break; }
        if (requestsThisSession >= CFG.MAX_REQUESTS_PER_SESSION) {
          stopReason = `session cap reached (${CFG.MAX_REQUESTS_PER_SESSION}) — reload to reset`;
          break;
        }
        const queue = buildQueue();
        if (!queue.length) { stopReason = 'complete — nothing stale'; break; }

        const job = queue[0];
        const r = await runOne(job);

        if (!r.ok) {
          // Do not retry, do not back off and continue. A server saying no is the
          // signal to stop entirely and let a human look at it.
          stopReason = `STOPPED on ${job.kind} ${job.username || job.page}: ${r.status || r.error}`;
          ui.arm = null;
          saveNow();
          console.warn(TAG, stopReason);
          break;
        }

        if (r.dry) { stopReason = `dry run — ${queue.length} job(s) pending`; break; }

        // 2xx that produced nothing usable: retire the job rather than re-serve it.
        if (!landed(job)) {
          blocked.add(jobId(job));
          log('no usable record from', jobId(job), '— retired for this session');
        }

        paint();
        await new Promise((res) => { nextTimer = setTimeout(res, jitter()); });
      }
    } finally {
      pumping = false;
      paint();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && armMode() === 'live') pump();
  });

  // ===========================================================================
  // Derived metrics
  // ===========================================================================
  const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

  function derive(r) {
    const last = ms(r.last_online);
    const made = ms(r.created_at);
    const idleMs = last ? Date.now() - last : null;
    const lifetimeMs = last && made ? last - made : null;
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
      staleMs: r.observedAt ? Date.now() - r.observedAt : null,
    };
  }

  const fmtDur = (msv) => {
    if (msv == null) return '—';
    const s = Math.floor(msv / 1000);
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    const d = Math.floor(s / 86400);
    return d < 365 ? `${d}d` : `${(d / 365).toFixed(1)}y`;
  };

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
    const by = {
      idle: (a, b) => (b.d.idleMs ?? -1) - (a.d.idleMs ?? -1),
      name: (a, b) => a.r.username.localeCompare(b.r.username),
      record: (a, b) => (b.d.lost - b.d.won) - (a.d.lost - a.d.won),
      fresh: (a, b) => (a.d.staleMs ?? 0) - (b.d.staleMs ?? 0),
    };
    return out.sort(by[ui.sort] || by.idle);
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

    const st = armState();
    const list = rows();
    const known = roster.usernames.length;
    const withProfile = Object.values(people).filter((r) => r.observedAt).length;
    const total = roster.total ?? '?';

    // keep the grip: it carries the drag listeners, everything below it is disposable
    panel.replaceChildren(grip);
    gripCov.textContent = `${withProfile}/${total} profiled · ${known} known`;

    const bar = document.createElement('div');
    bar.className = 'bar';

    const hours = document.createElement('select');
    for (const [l, h] of [['1h', 1], ['8h', 8], ['24h', 24], ['no expiry', 0]]) hours.append(new Option(l, String(h)));
    hours.value = String(CFG.DEFAULT_ARM_HOURS);

    for (const [label, mode] of [['off', null], ['dry', 'dry'], ['live', 'live']]) {
      const b = document.createElement('button');
      b.textContent = label;
      if (st.mode === (mode || 'off')) b.className = mode === 'live' ? 'on' : mode === 'dry' ? 'dry' : '';
      b.onclick = () => { mode ? arm(mode, Number(hours.value)) : disarm(); };
      bar.append(b);
    }
    bar.append(hours);
    panel.append(bar);

    const bar2 = document.createElement('div');
    bar2.className = 'bar';
    const sortSel = document.createElement('select');
    for (const [l, v] of [['most idle', 'idle'], ['worst record', 'record'], ['freshest data', 'fresh'], ['name', 'name']]) {
      sortSel.append(new Option(l, v));
    }
    sortSel.value = ui.sort;
    sortSel.onchange = () => { ui.sort = sortSel.value; save(); paint(); };
    bar2.append(sortSel);

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
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>player</th><th>idle</th><th>rank</th><th>W-L</th><th>seen</th></tr>';
    table.append(thead);
    const tb = document.createElement('tbody');
    for (const { r, d } of list.slice(0, 400)) {
      const tr = document.createElement('tr');
      const cells = [
        r.username + (d.neverStuck ? ' ◦' : ''),
        fmtDur(d.idleMs),
        r.rank_key || '—',
        d.record,
        fmtDur(d.staleMs),
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 0) td.append(profileLink(r.username), document.createTextNode(d.neverStuck ? ' ◦' : ''));
        else td.textContent = c;
        if (i === 0 && d.neverStuck) td.className = 'never';
        if (i === 1) td.className = 'idle';
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
    const pend = buildQueue().length;
    note.textContent = st.mode === 'off'
      ? `disarmed · ${pend} job(s) would run · ◦ = never stuck`
      : `${st.mode} · ${st.requestsThisSession}/${st.cap} reqs · ${pend} pending${stopReason ? ' · ' + stopReason : ''}`;
    panel.append(note);

    // the rows just changed the height, so re-place and re-check it is still reachable
    placePanel();
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  const boot = () => {
    mount();
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.toLowerCase() === CFG.HOTKEY) { ui.open = !ui.open; save(); paint(); }
    });
    if (armMode() === 'live') pump();
    log('ready —', armState().mode, '·', roster.usernames.length, 'known');
  };

  window.__pkpw = {
    arm, disarm, state: armState, dryReport,
    people: () => people,
    roster: () => roster,
    queue: () => buildQueue(),
    rows,
    stop: () => { clearTimeout(nextTimer); ui.arm = null; saveNow(); paint(); return 'stopped'; },
    resetFab: () => { ui.fab = defaultFabPos(); saveNow(); placeFab(); return ui.fab; },
    clear: () => { people = {}; roster = { total: null, totalPages: null, usernames: [], seenAt: 0, pages: {} }; saveNow(); paint(); return 'cleared'; },
    export: () => JSON.stringify({ people, roster }, null, 2),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
