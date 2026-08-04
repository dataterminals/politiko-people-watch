// Slices the real backfill queue and metric layers out of people-watch and exercises
// them against synthetic ledger state. The queue decides how many requests get
// originated against a live account, so it is the part worth pinning down: it must
// not re-serve a job that already landed, must not spin on one that never will, and
// must go quiet the moment everything is fresh.
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'people-watch.user.js'), 'utf8');

const cut = (from, to) => {
  const i = SRC.indexOf(from), j = SRC.indexOf(to);
  if (i < 0 || j < 0 || j <= i) throw new Error(`markers not found: ${from} .. ${to}`);
  return SRC.slice(i, j);
};

const Q_SLICE = cut('  // Jobs that came back 2xx but left no usable record', '  const jitter = ()');
const D_SLICE = cut('  const ms = (iso) =>', '  const fmtDur = (msv)');

const mkQueue = (people, roster, CFG) =>
  new Function('people', 'roster', 'CFG', `${Q_SLICE}\nreturn { buildQueue, blocked, jobId, landed };`)(people, roster, CFG);

const mkDerive = (CFG) =>
  new Function('CFG', `${D_SLICE}\nreturn { derive, ms };`)(CFG);

const CFG = {
  ROSTER_REFRESH_AFTER_MS: 6 * 3600_000,
  REFRESH_AFTER_MS: 12 * 3600_000,
  NEVER_STUCK_MS: 2 * 3600_000,
};

const HOUR = 3600_000;
const now = Date.now();
const fresh = now - 60_000;
const stale = now - 48 * HOUR;

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); fail++; }
};

const emptyRoster = () => ({ total: null, totalPages: null, usernames: [], seenAt: 0, pages: {} });
const ids = (jobs) => jobs.map((j) => (j.kind === 'roster' ? `r:${j.page}` : `p:${j.username}`));

console.log('\n— queue: roster enumeration —');
{
  const m = mkQueue({}, emptyRoster(), CFG);
  check('cold start asks for page 1 and nothing else', ids(m.buildQueue()), ['r:1']);
}
{
  const roster = { ...emptyRoster(), totalPages: 3 };
  const m = mkQueue({}, roster, CFG);
  check('known page count enumerates every page', ids(m.buildQueue()), ['r:1', 'r:2', 'r:3']);
}
{
  const roster = { ...emptyRoster(), totalPages: 3, pages: { 1: fresh, 2: fresh, 3: fresh } };
  const m = mkQueue({}, roster, CFG);
  check('freshly-walked roster queues nothing', ids(m.buildQueue()), []);
}
{
  const roster = { ...emptyRoster(), totalPages: 3, pages: { 1: fresh, 2: now - 7 * HOUR, 3: fresh } };
  const m = mkQueue({}, roster, CFG);
  check('only the stale page comes back', ids(m.buildQueue()), ['r:2']);
}

console.log('\n— queue: profiles —');
{
  const roster = { ...emptyRoster(), totalPages: 1, pages: { 1: fresh }, usernames: ['ana', 'bo', 'cy'] };
  const m = mkQueue({}, roster, CFG);
  check('every known player with no profile is queued', ids(m.buildQueue()), ['p:ana', 'p:bo', 'p:cy']);
}
{
  const roster = { ...emptyRoster(), totalPages: 1, pages: { 1: fresh }, usernames: ['ana', 'bo'] };
  const people = { ana: { username: 'ana', observedAt: fresh } };
  const m = mkQueue(people, roster, CFG);
  check('a fresh profile is not re-fetched', ids(m.buildQueue()), ['p:bo']);
}
{
  const roster = { ...emptyRoster(), totalPages: 1, pages: { 1: fresh }, usernames: ['ana', 'bo', 'cy'] };
  const people = {
    ana: { username: 'ana', observedAt: now - 20 * HOUR },
    bo: { username: 'bo', observedAt: now - 90 * HOUR },
    cy: { username: 'cy', observedAt: fresh },
  };
  const m = mkQueue(people, roster, CFG);
  check('stale profiles refresh oldest-observation first', ids(m.buildQueue()), ['p:bo', 'p:ana']);
}
{
  const roster = { ...emptyRoster(), totalPages: 1, pages: { 1: fresh }, usernames: ['ana', 'bo'] };
  const people = { ana: { username: 'ana', observedAt: fresh }, bo: { username: 'bo', observedAt: fresh } };
  const m = mkQueue(people, roster, CFG);
  check('a fully fresh ledger goes quiet', ids(m.buildQueue()), []);
}

console.log('\n— queue: retirement (the anti-spin guard) —');
{
  const roster = { ...emptyRoster(), totalPages: 1, pages: { 1: fresh }, usernames: ['ghost', 'bo'] };
  const m = mkQueue({}, roster, CFG);
  check('ghost is queued before being retired', ids(m.buildQueue()), ['p:ghost', 'p:bo']);
  m.blocked.add('p:ghost');
  check('retired job disappears from the queue', ids(m.buildQueue()), ['p:bo']);
}
{
  const roster = { ...emptyRoster(), totalPages: 2, pages: {} };
  const m = mkQueue({}, roster, CFG);
  m.blocked.add('r:1');
  check('a retired roster page is skipped too', ids(m.buildQueue()), ['r:2']);
}
{
  const roster = { ...emptyRoster(), totalPages: 1, pages: { 1: fresh }, usernames: ['ana'] };
  const people = { ana: { username: 'ana' } };  // roster-only, never profiled
  const m = mkQueue(people, roster, CFG);
  check('landed() is false for a roster-only record', m.landed({ kind: 'profile', username: 'ana' }), false);
  people.ana.observedAt = now;
  check('landed() flips once a profile is recorded', m.landed({ kind: 'profile', username: 'ana' }), true);
  check('landed() reads roster pages by number', m.landed({ kind: 'roster', page: 1 }), true);
  check('...and is false for an unseen page', m.landed({ kind: 'roster', page: 9 }), false);
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
