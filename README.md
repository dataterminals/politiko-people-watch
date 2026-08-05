# Politiko — People Watch

A userscript for [Politiko](https://politiko.io) that builds a local ledger of the players
it sees — last-online times, ranks, combat records — and sorts it least-active-first.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open [`people-watch.user.js`](https://raw.githubusercontent.com/dataterminals/politiko-people-watch/main/people-watch.user.js)
   and confirm the install prompt.

## What it does

The game rounds "last seen" to whole days in the UI, but sends exact timestamps. This keeps
the exact values, accumulates them across the profiles and roster pages you visit, and
ranks the result.

The gap between when an account was created and when it was last seen separates someone who
played for half an hour and left from someone who played for weeks — the UI renders both the
same way.

Everything is stored locally in your browser under `pkpw:` keys and can be cleared from the
panel.

## Arming — read this first

By default the script is **disarmed** on every load, and in that state it only reads
responses the game fetched on its own. It originates nothing.

**Armed in `live` mode, it crawls.** It issues paced, jittered, foreground-only requests to
the roster and profile endpoints to fill gaps in the ledger, capped per session and stopping
on the first non-2xx response. That reduces the footprint. It does not make the script
passive.

Politiko's scripting clause prohibits this, and the penalty is a game ban. Arming is a
deliberate choice with a real cost attached — the header comment in the script sets it out
in full. Arm it understanding that, or leave it disarmed and let the ledger fill from normal
play.

Arming is persistent and expiring: it does not silently stay on forever.

## What it reads

Full disclosure — reads, what it originates when armed, storage, network — is in the header
comment at the top of [`people-watch.user.js`](people-watch.user.js). Read it before
installing.

## Tests

```bash
node tools/test-people.js
node tools/test-placement.js
```

`test-people` exercises the backfill queue and metric layers against synthetic ledger state. The queue
decides how many requests get originated against a live account, so it is the part worth
pinning down: it must not re-serve a job that already landed, must not spin on one that
never will, and must go quiet once everything is fresh.

`test-placement` exercises the panel placement layer against a synthetic viewport: the
button stays on screen, and the panel stays fully visible from whichever corner the button
was dragged into.

Both slice their layers straight out of the shipped script, so they cannot drift from the
source.
