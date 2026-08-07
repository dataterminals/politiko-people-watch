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
