// Slices the real walk and metric layers out of people-watch and exercises them
// against synthetic ledger state.
//
// The queue suite that used to live here is gone with the crawler it tested: there is
// no longer any code that decides what to request, because nothing is requested. What
// replaces it is the walk, and that is worth pinning down for a different reason — it
// decides where a keypress sends you, and an off-by-one there means silently skipping
// a player on a 292-name list you are stepping through by hand.
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'people-watch.user.js'), 'utf8');

const cut = (from, to) => {
  const i = SRC.indexOf(from), j = SRC.indexOf(to);
  if (i < 0 || j < 0 || j <= i) throw new Error(`markers not found: ${from} .. ${to}`);
  return SRC.slice(i, j);
};

const W_SLICE = cut('  const PROFILE_RE =', '  // ===========================================================================\n  // Derived metrics');
const D_SLICE = cut('  const ms = (iso) =>', '  const fmtDur = (msv)');
const S_SLICE = cut('  const ms = (iso) =>', '  // ===========================================================================\n  // Panel');

/** rows() reads `people` and `ui` from the closure, so both are injected. */
const mkRows = (people, ui, CFG) =>
  new Function('people', 'ui', 'CFG', `${S_SLICE}\nreturn { rows, SORTS, COLUMNS, GROUPS, liveScore, derive };`)(people, ui, CFG);

/** goProfile is never called here — it only touches history/window, which are stubs. */
const mkWalk = (people, roster, pathname) =>
  new Function('people', 'roster', 'location', 'history', 'window', 'paint',
    `${W_SLICE}\nreturn { step, nextUnseen, currentProfile, walkOrder, mod };`)(
    people, roster, { pathname }, { pushState() {} }, { dispatchEvent() {} }, () => {});

const mkDerive = (CFG) => new Function('CFG', `${D_SLICE}\nreturn { derive, ms };`)(CFG);

const CFG = { NEVER_STUCK_MS: 2 * 3600_000 };

const HOUR = 3600_000;
const now = Date.now();

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); fail++; }
};

const rosterOf = (...usernames) => ({ total: usernames.length, totalPages: 1, usernames, seenAt: now, pages: { 1: now } });
const seen = (...usernames) => Object.fromEntries(usernames.map((u) => [u, { username: u, observedAt: now }]));

console.log('\n— walk: where am I —');
{
  const w = mkWalk({}, rosterOf('ana'), '/profile/ana');
  check('a profile route yields the username', w.currentProfile(), 'ana');
}
{
  const w = mkWalk({}, rosterOf('ana'), '/people');
  check('any other route yields null', w.currentProfile(), null);
}
{
  const w = mkWalk({}, rosterOf('a b'), '/profile/a%20b');
  check('an encoded name is decoded', w.currentProfile(), 'a b');
}

console.log('\n— walk: stepping —');
{
  const roster = rosterOf('ana', 'bo', 'cy');
  check('forward moves one', mkWalk({}, roster, '/profile/ana').step(1), 'bo');
  check('back moves one', mkWalk({}, roster, '/profile/bo').step(-1), 'ana');
  check('forward wraps at the end', mkWalk({}, roster, '/profile/cy').step(1), 'ana');
  check('back wraps at the start', mkWalk({}, roster, '/profile/ana').step(-1), 'cy');
}
{
  // you can land on a profile that was never on a roster page you walked
  const w = mkWalk({}, rosterOf('ana', 'bo'), '/profile/stranger');
  check('a stranger starts the walk at the top of the roster', w.step(1), 'ana');
}
{
  const w = mkWalk({}, rosterOf(), '/profile/ana');
  check('an empty roster has nowhere to go', w.step(1), null);
}

console.log('\n— walk: skipping to what is missing —');
{
  const roster = rosterOf('ana', 'bo', 'cy', 'di');
  const w = mkWalk(seen('bo', 'cy'), roster, '/profile/ana');
  check('skips players already profiled', w.nextUnseen(), 'di');
}
{
  const roster = rosterOf('ana', 'bo', 'cy');
  const w = mkWalk(seen('bo'), roster, '/profile/cy');
  check('wraps around to find one behind you', w.nextUnseen(), 'ana');
}
{
  const roster = rosterOf('ana', 'bo');
  const w = mkWalk(seen('ana', 'bo'), roster, '/profile/ana');
  check('a fully profiled roster has no next', w.nextUnseen(), null);
}
{
  // a roster-only record has no observedAt, so it still counts as unprofiled
  const roster = rosterOf('ana', 'bo');
  const w = mkWalk({ bo: { username: 'bo' } }, roster, '/profile/ana');
  check('a name seen on the roster but never opened is still unseen', w.nextUnseen(), 'bo');
}

console.log('\n— sorting: order and its reverse —');
{
  const SORT_CFG = { NEVER_STUCK_MS: 2 * HOUR, LIVE_TRUST_MS: 5 * 60_000 };
  const who = (n, over) => ({
    username: n, observedAt: now, is_npc: false, is_online: false,
    last_online: new Date(now - 3 * HOUR).toISOString(),
    created_at: new Date(now - 30 * 24 * HOUR).toISOString(),
    combat: { attacks_won: 1, attacks_lost: 1 }, ...over,
  });
  const ledger = {
    ana: who('ana', { last_online: new Date(now - 9 * 24 * HOUR).toISOString() }),   // most idle
    bo: who('bo', { last_online: new Date(now - 1 * HOUR).toISOString() }),
    cy: who('cy', { last_online: new Date(now - 30_000).toISOString() }),            // just now
  };
  const base = { hideNpc: true, hideOnline: false, minIdleDays: 0 };
  const names = (ui) => mkRows(ledger, { ...base, ...ui }, SORT_CFG).rows().map((x) => x.r.username);

  check('most idle, natural order', names({ sort: 'idle', dir: 1 }), ['ana', 'bo', 'cy']);
  check('...reversed', names({ sort: 'idle', dir: -1 }), ['cy', 'bo', 'ana']);
  check('name, natural order', names({ sort: 'name', dir: 1 }), ['ana', 'bo', 'cy']);
  check('...reversed', names({ sort: 'name', dir: -1 }), ['cy', 'bo', 'ana']);
  check('an unknown sort key falls back to idle', names({ sort: 'nope', dir: 1 }), ['ana', 'bo', 'cy']);

  // every sort must name a real column, or a header can never show as active
  const cols = new Set(mkRows({}, base, SORT_CFG).COLUMNS.map((c) => c.key));
  const S = mkRows({}, base, SORT_CFG).SORTS;
  check('every sort points at a real column',
    Object.values(S).every((s) => cols.has(s.col)), true);
  check('every column points at a real sort',
    mkRows({}, base, SORT_CFG).COLUMNS.every((c) => !!S[c.sort]), true);
}

console.log('\n— action counts: absent is not zero —');
{
  const CFG_A = { NEVER_STUCK_MS: 2 * HOUR, LIVE_TRUST_MS: 5 * 60_000 };
  const p = (n, alignment) => ({
    username: n, observedAt: now, is_online: false, combat: null, alignment,
    last_online: new Date(now - HOUR).toISOString(),
  });
  const ledger = {
    busy: p('busy', { social_count: 47, economic_count: 3 }),
    quiet: p('quiet', { social_count: 0, economic_count: 0 }),
    unknown: p('unknown', null),
    econ: p('econ', { social_count: 2, economic_count: 90 }),
  };
  const ui = { sort: 'social', dir: 1, hideNpc: true, hideOnline: false, minIdleDays: 0 };
  const m = mkRows(ledger, ui, CFG_A);

  check('most social actions first, never-observed last',
    m.rows().map((x) => x.r.username), ['busy', 'econ', 'quiet', 'unknown']);

  const d = Object.fromEntries(m.rows().map((x) => [x.r.username, x.d]));
  check('a genuine zero is a zero', d.quiet.socialActs, 0);
  check('an unobserved count is null, not zero', d.unknown.socialActs, null);
  check('political is the sum of both axes', d.busy.politicalActs, 50);
  check('...and stays null when neither axis was seen', d.unknown.politicalActs, null);

  const byPolitical = mkRows(ledger, { ...ui, sort: 'political' }, CFG_A)
    .rows().map((x) => x.r.username);
  check('economic volume counts toward political', byPolitical[0], 'econ');
}

console.log('\n— grouping —');
{
  const CFG_G = { NEVER_STUCK_MS: 2 * HOUR, LIVE_TRUST_MS: 5 * 60_000 };
  const { GROUPS } = mkRows({}, {}, CFG_G);
  check('none does not group', GROUPS.none.of, null);
  const r = { faction_name: 'The Hand', faction_rank: 'officer', corp_name: 'Nyx Media', corp_role: 'ceo' };
  check('faction reads faction_name', GROUPS.faction.of(r), 'The Hand');
  check('corp reads corp_name', GROUPS.corp.of(r), 'Nyx Media');
  check('an empty membership groups as null, not ""', GROUPS.faction.of({ faction_name: '' }), null);
  check('a missing membership groups as null', GROUPS.corp.of({}), null);
}

console.log('\n— "active now" only claims what it can support —');
{
  const CFG_L = { NEVER_STUCK_MS: 2 * HOUR, LIVE_TRUST_MS: 5 * 60_000 };
  const { liveScore } = mkRows({}, {}, CFG_L);
  const idle3h = 3 * HOUR;
  check('online, and freshly observed', liveScore({ is_online: true }, 60_000, idle3h), 3);
  check('online, but observed hours ago', liveScore({ is_online: true }, 3 * HOUR, idle3h), 2);
  check('not flagged online, but last seen a minute ago', liveScore({ is_online: false }, 3 * HOUR, 60_000), 1);
  check('nothing to suggest activity', liveScore({ is_online: false }, 3 * HOUR, idle3h), 0);
  check('an online flag with no observation time is not trusted',
    liveScore({ is_online: true }, null, idle3h), 2);
}
{
  const CFG_L = { NEVER_STUCK_MS: 2 * HOUR, LIVE_TRUST_MS: 5 * 60_000 };
  const stale = { username: 'stale', observedAt: now - 6 * HOUR, is_online: true,
    last_online: new Date(now - 6 * HOUR).toISOString(), combat: null };
  const fresh = { username: 'fresh', observedAt: now - 30_000, is_online: true,
    last_online: new Date(now - 30_000).toISOString(), combat: null };
  const quiet = { username: 'quiet', observedAt: now - 30_000, is_online: false,
    last_online: new Date(now - 4 * 24 * HOUR).toISOString(), combat: null };
  const ui = { sort: 'live', dir: 1, hideNpc: true, hideOnline: false, minIdleDays: 0 };
  const got = mkRows({ stale, fresh, quiet }, ui, CFG_L).rows().map((x) => x.r.username);
  check('a trusted online reading outranks a stale one', got, ['fresh', 'stale', 'quiet']);

  const marked = mkRows({ stale, fresh, quiet }, ui, CFG_L).rows()
    .filter((x) => x.d.liveNow).map((x) => x.r.username);
  check('only the fresh one is marked live', marked, ['fresh']);
}

console.log('\n— metrics —');
{
  const { derive } = mkDerive(CFG);
  const d = derive({
    last_online: new Date(now - 4 * 24 * HOUR).toISOString(),
    created_at: new Date(now - 4 * 24 * HOUR - 39 * 60_000).toISOString(),
    combat_record: null,
    combat: { attacks_won: 0, attacks_lost: 7 },
  });
  check('idle days computed from last_online', Math.round(d.idleDays), 4);
  check('39 minutes of lifetime reads as never-stuck', d.neverStuck, true);
  check('W-L renders from the combat record', d.record, '0-7');
}
{
  const { derive } = mkDerive(CFG);
  const d = derive({
    last_online: new Date(now - 4 * 24 * HOUR).toISOString(),
    created_at: new Date(now - 20 * 24 * HOUR).toISOString(),
    combat: { attacks_won: 12, attacks_lost: 3 },
  });
  check('a long-lived account is not never-stuck', d.neverStuck, false);
  check('record survives a winning player', d.record, '12-3');
}
{
  const { derive } = mkDerive(CFG);
  const d = derive({ last_online: null, created_at: null, combat: null });
  check('missing last_online yields null idle, not NaN', d.idleMs, null);
  check('missing combat record still renders', d.record, '0-0');
  check('never-stuck is false when there is nothing to compare', d.neverStuck, false);
}

console.log(fail ? `\n${fail} FAILED\n` : '\nALL OK\n');
process.exit(fail ? 1 : 0);
