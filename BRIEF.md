# bb-plugin-linear — build brief

Linear inside bb: issues, inbox, triage, projects and cycles at parity for
daily engineering work — and every bb thread knowing which issue it is
working on, live, in the header, the side panel, and the agent's own context.

Public, MIT. Nothing in shipped code, fixtures, or copy may name an org, a
team, a workspace slug, a state name, a label convention, an estimate scale,
or a personal path. Everything is discovered at runtime or configured through
settings. Secrets never reach a log, the repo, the UI, an agent tool result,
an rpc error, or a realtime payload.

This document records each decision **with the alternative it beat**. When a
later change fights one of these, re-argue it here first.

---

## 0. Reference material

Public, canonical:

- bb source: `https://github.com/get-bb/bb` — `packages/plugin-sdk/src/`,
  `apps/server/src/services/plugins/`, `plugins/github` (closest official
  exemplar: navPanel + headerContent, background sync, rpc + realtime, CLI,
  agent-spawn buttons).
- The bb-plugin-authoring skill (ships with bb) is the API guide; the
  authoritative surface is this repo's own `types/*.d.ts`, refreshed by
  `bb plugin types`. Never read minified `dist/` to answer an API question.
- Linear GraphQL SDL: vendored at `src/schema/linear.graphql` (1.3 MB).
  Regenerate: `npx -y get-graphql-schema --header "Authorization=$LINEAR_API_KEY"
  https://api.linear.app/graphql > src/schema/linear.graphql`.

On the author's machine only (not shipped, not required):
`~/Git/bb-plugin-linear-archived` — the predecessor. Different product
thesis (seams-only, deliberately not a client), but its *experimentally
verified* host and API findings carry over and are restated below wherever
they bind.

**Hard host gotchas (verified by the predecessor; treat as constraints):**

1. The plugin Tailwind build **drops arbitrary values containing commas** —
   `min-w-[min(10px,20px)]` vanishes silently. `w-[26rem]`, `text-[13px]`,
   `calc(100%-1rem)`, `var(--x)` are fine. Anything needing `color-mix(…)`
   or comma-bearing values lives in `app.css`, never in a class string.
2. Plugin CSS is `@scope`-wrapped: utilities match **descendants of the scope
   root only, never the root element**. Every portaled overlay is a naked
   shell plus a styled inner wrapper (`lib/portal-scope.ts` pattern:
   `usePortalScopeProps()` spread on every `*Portal` child).
3. A hidden **child** thread reports its turns to its parent as a user
   message. Any worker thread this plugin ever spawns is spawned
   **unparented**. v1 spawns none; the rule exists so nobody adds one
   carelessly.
4. Secret settings are raw files with no trim: a key pasted with a trailing
   newline 401s in a way that reads exactly like a revoked key. **Read fresh
   inside every handler, `.trim()` at every read, never capture into module
   scope** — a key replaced while bb runs takes effect on the next request.
5. `bb.sdk` is bind-gated: fine in factories on a real server, throws in
   isolated harnesses — prefer handlers/services/timers.
6. kv values cap at 256 KB (cursors and links only; datasets go in the
   plugin database). `storage.migrate` is append-only by statement index.
7. Thread lifecycle events are observe-only and exactly six; `thread.created`
   fires before the first message lands — react on `thread.active` /
   `thread.idle` and read `bb.sdk.threads.timeline`.
8. Tool names are unique **across plugins** (prefix everything `linear_`).
   Tool/instruction changes apply at next session start, never mid-session.
9. `bb.agents.contributeInstructions` is synchronous, on the thread-start
   path, capped 4096 chars — serve it from an in-memory cache, never I/O.
10. CLI stdout+stderr cap: `PLUGIN_CLI_OUTPUT_MAX_BYTES` (1 MiB), rejected
    atomically, never clipped — page everything.
11. Never stash `bb` in module state that outlives a load
    (`PluginContextStaleError`); `onDispose` runs LIFO.
12. Frontend styling: host token classes only (`bg-card`,
    `text-muted-foreground`, …). No custom `@theme` colors, no literal
    oklch/grays — the build emits default-theme utilities and hardcoded
    colors break user palettes.

---

## 1. What it is

A Linear client and a Linear seam, in one plugin:

- **Client**: browse and act on issues, inbox, triage, projects and cycles
  from bb's left nav panel — at parity for daily work, so linear.app stays
  closed. List-first at sidebar width; a board is a grouped list turned
  sideways, and the sideways part is deferred.
- **Seam**: every thread resolves *which issue it is working on* through a
  deterministic ladder, shows it in the thread header and side panel, hands
  it to agents as per-turn context, and (opt-in, off by default) moves the
  issue as the work moves.

The predecessor refused to be a client. This build deliberately reverses
that one decision — parity for daily work is the point — and keeps every
architectural finding that made the seam trustworthy.

**What bb already owns and this plugin never rebuilds:** threads,
environments, worktrees, branch names, git state, PR status and merge
actions, the markdown renderer, the composer, the toaster, the settings
form, the credential store. No diff view, no branch picker, no merge button,
no second toaster, no second API-key field outside declared settings.

---

## 2. Decisions (each with the alternative it beat)

**D1 — GraphQL with its own credential; not Linear's MCP.** MCP OAuth lives
inside one agent CLI's session: a background service cannot borrow it (no
polling, no notifications, no 2am automation), and it is invisible to
non-Claude providers while bb routinely runs Codex, Kimi, OpenCode, Gemini.
Owning the API: one credential, one source of truth, identical behavior in
panel, CLI, tools, automations. Where a user's agents *also* have Linear MCP,
this plugin's automations stay off by default (D7) so the two never fight.

**D2 — Personal API keys; OAuth stays open, unhosted.** OAuth would buy
`actor=app` attribution, higher ceilings, and the Agents API — and would
require the author to ship a client secret and host a redirect, turning an
MIT plugin into a service with an operator. *A stranger can use this without
asking the author for anything* outranks all three. The transport is written
against a credential union from day one so a bring-your-own OAuth client can
slot in without rearchitecting.

**D3 — Multi-account = fixed secret slots, workspace discovered.** A Linear
personal API key is scoped to one workspace, so N workspaces genuinely need
N keys. Settings declare `apiKey`, `apiKey2`, `apiKey3`, `apiKey4` (a secret
setting's key is the filename it lives in — declared up front, never
renamed). Identity (user, workspace) is discovered per key via `viewer` at
runtime; nothing about a workspace is ever configured by hand. Key scopes
are **not introspectable** (no `apiKeys`/`viewerScopes` root field, and
`teams` cannot see teams a restricted key was scoped away from) — so the
plugin never claims "read-only" or "2 of 3 teams"; restrictions are
discovered by failure and reported where they surface (`bb linear doctor`,
connection section).

**D4 — Accounts compose by context, not by a global mode.** A bb project
binds to one (account, team); thread surfaces — header chip, side panel,
binding, tools' defaults — resolve from that binding with zero switching.
The nav panel carries a workspace switcher for roaming; the inbox merges
accounts with workspace badges. Beat: a Linear-style global workspace
switcher (loses bb's one advantage: context), and merge-everything (cross-
account writes become a standing footgun).

**D5 — Hybrid data layer.** SQLite (`bb.storage.database()`) mirrors the
working set — accounts, teams, workflow states, labels, users, projects,
cycles, my issues, inbox notifications, and every issue a thread is bound
to. Webhooks (when reachable) plus reconciliation polling keep it honest;
`bb.realtime.publish` fans changes out to mounted UI; long-tail search and
arbitrary drill-ins go straight to GraphQL. Beat: full mirror (rebuilding
Linear's sync engine; slow first sync) and live-only (blank panels offline,
rate limits burned by browsing, and background automation needs its own
fetch path anyway). Personal keys budget ~1,500 requests/hour
complexity-weighted — the poller uses coalesced delta queries
(`updatedAt > cursor` filters) and the budgeter is one module every caller
goes through.

**D6 — The binding ladder, fuzzy suggests only.** A thread's issue resolves:
explicit pin (thread started from an issue, or attached by hand) → branch
name matching Linear's own `gitBranchName` convention → issue key or URL in
thread messages → fuzzy title match against the bound team's issues. The
deterministic layers auto-bind with provenance shown ("bound via branch");
fuzzy renders as a suggestion — "Looks like ABC-123 — bind?" — one click,
never silent. Manual override always wins and sticks. Bindings persist in
the plugin database keyed by thread id, re-evaluated on thread lifecycle
events and branch changes. `contributeInstructions` serves the bound issue
(key, title, state, one-line provenance) from an in-memory cache so every
agent turn knows its task with zero tool calls. Beat: silent fuzzy auto-bind
(a wrong binding plus write-back moves the wrong ticket).

**D7 — Write-back ships OFF.** Git facts (branch pushed, PR opened, merged)
and thread facts (bound + actively working) can move the issue — using the
team's **own** Linear git-automation target states, idempotently, and only
on deterministic bindings. All of it is opt-in per scope and off by default,
because many users' agents already drive Linear (MCP or these tools) and two
writers fighting over one card is worse than either alone. Beat: on-by-
default (the predecessor's stance, right for a seams-only plugin, wrong for
one that coexists with agent-driven writes).

**D8 — Full parity toolset, consolidated shapes.** Agents get `linear_*`
tools covering issues (one `linear_save_issue` for create+update, not a
dozen micro-tools), search, comments, projects, cycles, statuses/labels
discovery, plus the tools only bb can have: `linear_context` (the thread's
bound issue + team vocabulary + branch name), `linear_bind`. One credential,
identical in every provider, discoverable via ToolSearch. A `skills/linear/`
skill teaches conventions. Beat: context-only tools (useless to users
without MCP — and this is a public plugin) and mirroring MCP's exact tool
list (their shapes, our worse fit).

**D9 — Surfaces.** `navPanel` (the client), `experimental_threadHeaderAction`
(one 28px chip: key + state dot + truncated title; unbound-with-candidate
renders the suggestion; everything bigger in a portaled popover),
`threadPanelAction` (issue detail: description, controls, sub-issues,
relations, comments, activity — also openable for any issue named in chat),
`settingsSection` (accounts: per-key discovered identity, connection health),
mention provider (`@issue` → send-time context resolve), message directive
(`::linear{key="ABC-123"}` renders an issue card in chat). Notifications:
nav badge always; toasts only for direct items (assignment, mention, reply),
configurable, quiet by default.

**D10 — UI is vendored shadcn from the @bb registry.** `bb plugin new`
seeded button/card/input/dialog; further components come from
`npx shadcn add @bb/<item>` so vendored source is version-matched to the
running bb by construction. Tailwind v4, React 19, host token classes,
`toast` from `sonner` (host-shimmed). Beat: hand-rolled components (worse,
slower) and any host-component dependency beyond the sanctioned `ThreadChat`
/ `Markdown` / `experimental_NewThreadComposer`.

**D11 — List-first nav panel; no kanban in v1.** Collapsible state groups,
dense rows, a filter bar, saved views per team, projects and cycles pages,
live search. A sidebar-width board is a cramped board; Linear's list idiom
is its primary view anyway. Revisit boards only if bb grows a wide surface.

---

## 3. Architecture

```
server.ts            wiring only: settings, storage, services, rpc, tools, cli
src/
  schema/linear.graphql     vendored SDL (append-only regeneration)
  transport/          GraphQL client, credential union, budgeter, retries
  accounts/           key slots → discovered identities, health
  mirror/             SQLite schema + migrations, delta sync, webhook apply
  binding/            the ladder, provenance, in-memory cache for instructions
  automations/        git/thread → state moves (off by default)
  tools/              linear_* registrations (thin over mirror/transport)
  cli/                bb linear subcommands (thin over the same modules)
  webhooks/           route handler, signature verification, replay guard
app.tsx              slot registrations only
app/                 nav panel views, header chip, issue panel, settings
components/ui/       vendored shadcn (owned, editable)
skills/linear/       agent conventions
test/                vitest against @bb/plugin-sdk/testing
```

Rules: pure logic lives in `src/` modules testable without a host; `server.ts`
and `app.tsx` only wire. Every Linear request goes through the budgeter.
Every log line goes through `redact()`. rpc contract in one shared module;
realtime channels are named, documented, and carry "something changed"
signals only — the frontend refetches via rpc, payloads never carry issue
data (they'd be a second source of truth and a leak surface).

Webhooks: one `bb.http.route` with `auth: "none"` + Linear's HMAC signature
verified inside the handler (reject unsigned/invalid before any parsing
side effects). Registration is automatic when a public URL is available and
verified by a round-trip; absent that, polling covers everything — webhooks
are an upgrade, never a requirement.

---

## 4. Milestones

Tracked as issues in a Linear team once M1 lands (dogfood: the plugin's own
tools file and move them). Each milestone ends installed, typechecked,
tested, and exercised live.

- **M1 Transport + accounts + doctor.** Typed GraphQL over the vendored SDL,
  credential union, budgeter, per-key identity discovery, `bb linear doctor`
  (connection, identity, budget, webhook state — and nothing it cannot
  know, per D3).
- **M2 Mirror + webhooks + polling.** Schema, append-only migrations, delta
  sync for the working set, webhook route + verification + auto-registration
  with polling fallback, realtime signals.
- **M3 Binding + header + side panel.** The ladder with provenance,
  suggestion UX, header chip, issue detail panel, live updates,
  `contributeInstructions` from cache.
- **M4 Nav panel.** Switcher, My Issues, team views (collapsible state
  groups, filter bar), projects, cycles, live search.
- **M5 Inbox + triage.** Merged inbox with workspace badges, nav badge,
  quiet configurable toasts, triage queue with configurable label
  conventions (defaults ship generic; any `namespace:value` scheme is
  configuration).
- **M6 Toolset + CLI + skill.** Full `linear_*` set, `bb linear`
  (`doctor accounts bind open create my`), `skills/linear/SKILL.md`.
- **M7 Automations (off).** Team git-automation targets, idempotent moves,
  deterministic-bindings-only, per-scope opt-in; mention provider +
  `::linear` directive land here too.
- **M8 Start thread from issue.** Issue row → compose seeded with an
  `@issue` mention pill (send-time context), title, and the issue's
  `gitBranchName`.

## 5. Non-goals (v1)

Board view. Hosted OAuth. Auto progress comments. Documents, initiatives,
roadmaps, insights. Dependencies on other bb plugins. Spawned worker
threads.

## 6. Testing

`createFakePluginHost` for backend behavior (real better-sqlite3 storage,
rpc round-trips, service/schedule driving, tool calls, thread events);
`renderSlot` for panel/chip/panel-detail UI; pure-module unit tests for the
ladder, budgeter, delta merge, signature verification (fixtures, no
network). Live loop via `bb plugin dev` against a real workspace. Smoke
checklist maintained in `docs/smoke.md` from M2 on.
