# Politiko — People Watch

A userscript for [Politiko](https://politiko.io) that builds a local ledger of the players
you look at — last-online times, ranks, combat records — and sorts it least-active-first.

It is **fully passive**. It reads responses the game already made, on pages you are
actively viewing, and originates no requests of its own.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open [`people-watch.user.js`](https://raw.githubusercontent.com/dataterminals/politiko-people-watch/main/people-watch.user.js)
   and confirm the install prompt.

## What it's for

The game rounds "last seen" to whole days in the UI, but the API sends exact timestamps.
This keeps the exact values and ranks by them, so you can tell six days idle from six
hours.

It also computes something the UI can't show at all: the gap between `created_at` and
`last_online`. Someone who played for 39 minutes and quit, and someone who played for three
weeks and then stopped, both render as "4 days" in game. A `◦` next to a name means their
entire account lifetime was under two hours — they never really engaged.

## How to use it

**Alt+P**, or click the triangle button, to open the panel. Drag either wherever you like;
they remember.

The header shows two numbers — `12/292 profiled · 40 known`:

- **known** — usernames it has seen on roster pages (the People tab)
- **profiled** — players it actually has data for

Only profiled players appear in the table. A username on its own gives it nothing to rank.

So the loop is:

1. **Open the People tab and page through it.** Every page is captured for free — that's
   `known` climbing, and it's what the walk below needs.
2. **Open profiles.** Each one you open is recorded permanently, at full precision.
3. **Walk the roster.** On any profile page the panel grows a walk bar:

   | control | does |
   |---|---|
   | `‹ [` | previous player in the roster |
   | `] ›` | next player |
   | `next unseen ›` | skip ahead to someone with no profile yet |

   The `[` and `]` keys do the same thing without the panel open, so a pass through the
   roster is one keypress per player. They are ignored while you are typing, so chat
   still works.
4. **Read the table.** Sort **most idle**, set **≥7d idle**, tick **hide npc** and
   **hide online**. Player names are links — click one to jump straight there.

Each step is a normal navigation. The game fetches that profile exactly as it would if you
had clicked the player yourself, and the tap records what comes back.

## The table

| column | what it is |
|---|---|
| player | name, `◦` if they never engaged; click to open |
| idle | time since last online — exact, not the game's rounding |
| rank | their `rank_key` |
| W-L | attacks won–lost, so "worst record" finds people who lose |
| seen | how stale *your* copy of their profile is |

**Click any header to sort by it; click it again to flip the order.** The dropdown does the
same thing and stays in sync with the headers, and the button beside it reverses whatever is
currently selected. Each sort's natural order matches its label — "most idle" puts the most
idle first, "name" goes A→Z — and reversing flips that, which is why one toggle works across
columns that don't share a direction.

### "Active now", and what it can honestly tell you

There is no presence feed. `is_online` is a claim about *this moment* taken from an
observation made whenever you last opened that profile, so it decays: someone marked online
three days ago is just someone who was online once.

The **active now** sort ranks by how much the ledger can actually support:

1. seen online, and seen within the last five minutes
2. seen online, but a while ago — no evidence about now
3. not flagged online, but their `last_online` is within minutes
4. everything else, most recent first

Only the first tier is shown as a green **● online** in the idle column. The second tier
sorts high but still displays plain idle time, because claiming otherwise would be inventing
a fact. If you want this to mean something, walk the roster first — the readings are only as
current as your last pass.

## Console

```js
__pkpw.unseen()    // usernames known but not yet profiled
__pkpw.rows()      // the table, as data
__pkpw.export()    // the whole ledger as JSON
__pkpw.clear()     // wipe it
```

## What it reads

Full disclosure — reads, storage, network — is in the header comment at the top of
[`people-watch.user.js`](people-watch.user.js). In short: it reads `/api/people` and
`/api/users/<name>` responses the game itself requested, stores them under `pkpw:` keys in
your browser, and sends nothing anywhere.

**The ledger holds other players' public profile data.** It never leaves your browser and
must not be committed anywhere.

## History

Versions up to 0.4.0 shipped an opt-in crawler that originated paced requests to fill the
ledger automatically. Politiko's scripting clause prohibits that and the penalty is a game
ban; it was carried as a knowingly accepted risk.

**It is gone as of 1.0.0** — the arming system, the queue, the pacing and every
request-originating line were removed rather than disabled. The walk replaces it, and the
walk is just you pressing a key.

## Tests

```bash
node tools/test-people.js
node tools/test-placement.js
```

`test-people` covers the walk layer — where a keypress sends you, and which players
`next unseen` is allowed to skip — plus the derived metrics. An off-by-one in the walk
means silently missing a player on a list you are stepping through by hand.

`test-placement` covers the panel placement layer against a synthetic viewport: the button
stays on screen and clear of the game's Comms dock, and the panel stays fully visible from
whichever corner the button was dragged into.

Both slice their layers straight out of the shipped script, so they cannot drift from it.
