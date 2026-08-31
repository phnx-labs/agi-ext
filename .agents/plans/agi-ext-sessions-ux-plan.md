---
kind: plan
surface: web
title: "AGI EXT — Sessions view UX overhaul: real prompts, readable timing, links that go somewhere, working grouping"
summary: >
  A full pass over the Sessions row + expanded card + list controls, fixing ten
  user-flow problems: THE ASK shows a header not the real prompt; timing is raw and
  ambiguous; pills copy silently or do nothing; device is shown three times; Resume vs
  Resume-here is confusing; logo and name are both shown; the "Group Project" control
  does nothing. Adds real grouping (project / device / status) and a status model
  (active / idle / waiting / blocked).
status: implemented
links:
  - https://linear.app/issue/PHNX-3621
---

## Focus for review

The genuine decisions — everything else follows from these:

1. **Status model.** A session is `active` (working), `idle` (running but stopped —
   waiting on your input / a permission prompt), `waiting` (waiting on a tool/CI),
   `blocked` (needs a decision only you can make), `done`/`previous` (ended). Filter
   chips and Group-by-Status use this taxonomy. Confirm the words.
2. **Grouping.** Bring back a Group control that actually works: **Project · Device ·
   Status · None**. (Today "Group Project" is shown but the Previous list is flat.)
3. **Resume semantics.** A plain, compact **Resume** that reopens the session on the
   machine it ran on (not copied to your Mac). **Right-click → "Resume on a different
   device…"** for the power case. Drop the second "Resume here" and the oversized
   labeled button.
4. **THE ASK source.** The real first user message, not the recap header ("## Apps").
   If the stream only carries the header, this needs one new field on the CLI row
   (`firstUserMessage`) — a small CLI change, not a rebuild.

## Purpose

The ten problems from your testing — this table is the acceptance checklist:

<div class="artifact-callout artifact-callout-warn">
Every one of these is a real user-flow break you hit, not a nitpick. The list below
is the acceptance checklist for this change.
</div>

| # | What's wrong today | The fix |
|---|---|---|
| 1 | THE ASK shows `## Apps (Connectors)` — a header, not your prompt | Show the real first user message, full, with **See more** |
| 2 | `Last active 4:42 PM · started 4:42 PM` — raw, identical, no duration | `Ran 2m · ended 9m ago` (absolute on hover) |
| 3 | `4m` on the row — ago? duration? | `9m ago` (always relative to last activity), labeled |
| 4 | Pills copy silently / a repo pill click does nothing | Ticket → Linear, PR → GitHub PR, repo → GitHub repo (real navigation, `↗`) |
| 5 | Device shown 3× (chip row, ended line, catch-up) | Once — `Runs on yosemite-m3` in the card |
| 6 | `Resume` vs `Resume here` — which? does it copy the session? | One button `Resume on <device>` with a plain-language subtitle |
| 7 | Logo **and** the agent name (`codex`, `kimi`) both shown | Logo only |
| 8 | `Group Project` is set but the list is flat — nothing groups | Real grouping: Project / Device / Status / None |
| 9 | No way to see session **status** (idle / waiting / blocked) | Status chips + Group by Status |
| 10 | The row-render code is messy (why fixes kept regressing) | Refactor `SessionsPane.tsx` into small components |

## Design

### The expanded card — before vs after (the hero)

<figure class="artifact-figure artifact-behavior">
<figcaption>Expanded session card. Left: today's confusing card. Right: real request, readable timing, links that navigate, device once, one Resume.</figcaption>

<section data-state="current" data-evidence="capture">
<svg viewBox="0 0 600 356" xmlns="http://www.w3.org/2000/svg" font-family="Geist, system-ui, sans-serif">
  <text x="0" y="12" font-size="10.5" font-family="ui-monospace, monospace" letter-spacing="0.5" fill="#f87171">TODAY — HEADER NOT PROMPT · RAW SAME DATES · SILENT PILLS · DEVICE 3× · TWO RESUMES</text>
  <rect x="0.5" y="22.5" width="599" height="332" rx="10" fill="#0a0a0a" stroke="#1b2334"/>
  <rect x="16" y="36" width="16" height="16" rx="4" fill="#12172a" stroke="#242a44"/><text x="19" y="48" font-size="10" fill="#7a86b0">c</text>
  <text x="40" y="48" font-size="10.5" font-family="ui-monospace,monospace" fill="#8b94a6">codex</text>
  <text x="82" y="48" font-size="12" font-weight="600" fill="#e6e9ef">PRIX  ## Apps (Connectors)</text>
  <text x="300" y="48" font-size="10" fill="#f87171">✕ logo + name both · title is a header</text>
  <text x="16" y="78" font-size="9.5" font-family="ui-monospace,monospace" letter-spacing="0.8" fill="#6E6A63">THE ASK</text>
  <rect x="16" y="84" width="568" height="30" rx="6" fill="#0b101c" stroke="#1b2334"/>
  <text x="26" y="103" font-size="12" fill="#8b94a6">## Apps (Connectors)</text>
  <text x="300" y="103" font-size="10" fill="#f87171">✕ not the real prompt · can't see more</text>
  <text x="16" y="138" font-size="9.5" font-family="ui-monospace,monospace" letter-spacing="0.8" fill="#6E6A63">ENDED SESSION</text>
  <rect x="16" y="144" width="568" height="26" rx="6" fill="#0c1017" stroke="#1b2334"/>
  <text x="26" y="161" font-size="11.5" fill="#8b94a6">Last active Aug 30, 4:42 PM · started Aug 30, 4:42 PM · resumable on yosemite-m3</text>
  <text x="16" y="186" font-size="10" fill="#f87171">✕ raw dates · start = last active · no duration · device #2</text>
  <text x="16" y="214" font-size="9.5" font-family="ui-monospace,monospace" letter-spacing="0.8" fill="#6E6A63">CATCH UP</text>
  <rect x="16" y="222" width="60" height="22" rx="6" fill="#0c1220" stroke="#1b2334"/><text x="24" y="237" font-size="11" fill="#8b94a6">▪ prix</text>
  <rect x="82" y="222" width="80" height="22" rx="6" fill="#0c1220" stroke="#1b2334"/><text x="90" y="237" font-size="11" fill="#8b94a6">Session ↗</text>
  <rect x="168" y="222" width="98" height="22" rx="6" fill="#0c1220" stroke="#1b2334"/><text x="176" y="237" font-size="11" fill="#8b94a6">◈ yosemite-m3</text>
  <rect x="360" y="221" width="112" height="24" rx="6" fill="#161e0b" stroke="#34401a"/><text x="370" y="237" font-size="11.5" fill="#a3e635">↻ Resume here</text>
  <text x="16" y="266" font-size="10" fill="#f87171">✕ "prix" does nothing on click · device #3 · "Resume here" vs the row's "Resume" = ?</text>
  <text x="16" y="292" font-size="10" fill="#f87171">✕ and up top the row already had a green "Resume" — two resume buttons, unclear difference</text>
</svg>
</section>

<section data-state="proposed" data-evidence="mockup">
<svg viewBox="0 0 600 356" xmlns="http://www.w3.org/2000/svg" font-family="Geist, system-ui, sans-serif">
  <text x="0" y="12" font-size="10.5" font-family="ui-monospace, monospace" letter-spacing="0.5" fill="#84cc16">PROPOSED — REAL REQUEST · READABLE TIMING · LINKS NAVIGATE · DEVICE ONCE · ONE RESUME</text>
  <rect x="0.5" y="22.5" width="599" height="332" rx="10" fill="#0a0a0a" stroke="#1b2334"/>
  <!-- header: logo only, real title -->
  <rect x="16" y="36" width="18" height="18" rx="4" fill="#12172a" stroke="#242a44"/><text x="19" y="49" font-size="10" fill="#7a86b0">◎</text>
  <text x="42" y="49" font-size="10.5" font-family="ui-monospace,monospace" fill="#5eead4">prix</text>
  <text x="76" y="49" font-size="13" font-weight="600" fill="#e6e9ef">Wire the Connectors page to the live apps list</text>
  <text x="560" y="49" font-size="11" text-anchor="end" fill="#5c6675">⌃</text>
  <!-- your request (real, see more) -->
  <text x="16" y="78" font-size="9.5" font-family="ui-monospace,monospace" letter-spacing="0.8" fill="#6E6A63">YOUR REQUEST</text>
  <rect x="16" y="84" width="568" height="46" rx="6" fill="#0b101c" stroke="#1b2334"/>
  <text x="26" y="103" font-size="12" fill="#c5ccd6">"Under ## Apps (Connectors), wire the connector cards to the live apps list</text>
  <text x="26" y="119" font-size="12" fill="#c5ccd6">and show a real status dot per connector…"  <tspan fill="#6ea8fe">See more</tspan></text>
  <!-- timing meta: readable -->
  <text x="16" y="150" font-size="9.5" font-family="ui-monospace,monospace" letter-spacing="0.8" fill="#6E6A63">SESSION</text>
  <rect x="16" y="156" width="568" height="26" rx="6" fill="#0c1017" stroke="#1b2334"/>
  <text x="26" y="173" font-size="11.5" fill="#c9d4c0">Ran 2m · ended 9m ago</text>
  <text x="196" y="173" font-size="11.5" fill="#6E6A63">·  Runs on</text><text x="262" y="173" font-size="11.5" fill="#c9d4c0">yosemite-m3</text>
  <text x="470" y="173" font-size="10" fill="#5c6675">Aug 30, 4:42–4:44 PM</text>
  <!-- links: navigate -->
  <text x="16" y="204" font-size="9.5" font-family="ui-monospace,monospace" letter-spacing="0.8" fill="#6E6A63">LINKS</text>
  <rect x="16" y="212" width="104" height="22" rx="6" fill="#0c1a2e" stroke="#1c3a5a"/><text x="24" y="227" font-size="11" fill="#6ea8fe">◇ PHNX-3542 ↗</text>
  <rect x="126" y="212" width="78" height="22" rx="6" fill="#0c1a2e" stroke="#1c3a5a"/><text x="134" y="227" font-size="11" fill="#6ea8fe">▪ prix ↗</text>
  <rect x="210" y="212" width="76" height="22" rx="6" fill="#0c1220" stroke="#241d3a"/><text x="218" y="227" font-size="11" fill="#a78bfa">⑂ main ⧉</text>
  <text x="300" y="227" font-size="10" fill="#84cc16">✓ ticket→Linear · repo→GitHub (↗) · branch→copy (⧉)</text>
  <!-- one normal Resume; right-click for device options -->
  <rect x="16" y="256" width="82" height="26" rx="6" fill="#161e0b" stroke="#34401a"/>
  <text x="27" y="273" font-size="12" font-family="ui-monospace,monospace" fill="#a3e635">↻ Resume</text>
  <text x="110" y="273" font-size="10.5" fill="#6E6A63">right-click ▸ <tspan fill="#8b94a6">Resume on a different device…</tspan></text>
  <text x="16" y="310" font-size="10" fill="#84cc16">✓ normal Resume (reopens on yosemite-m3, where it ran) · right-click for device options · logo only</text>
</svg>
</section>
</figure>

### List controls & grouping — before vs after

<figure class="artifact-figure artifact-behavior">
<figcaption>Filter + group controls. Left: dead "Group Project" over a flat list. Right: status chips + real grouping with section headers that actually split the list.</figcaption>

<section data-state="current" data-evidence="capture">
<svg viewBox="0 0 600 150" xmlns="http://www.w3.org/2000/svg" font-family="Geist, system-ui, sans-serif">
  <text x="0" y="12" font-size="10.5" font-family="ui-monospace, monospace" letter-spacing="0.5" fill="#f87171">TODAY — "GROUP PROJECT" SET, BUT THE LIST IS ONE FLAT "PREVIOUS" BAND</text>
  <rect x="0.5" y="22.5" width="599" height="126" rx="10" fill="#0a0a0a" stroke="#1b2334"/>
  <rect x="14" y="35" width="50" height="20" rx="10" fill="#1a1a1a" stroke="#ffffff26"/><text x="24" y="49" font-size="11" fill="#E7E5E4">All</text>
  <rect x="70" y="35" width="58" height="20" rx="10" fill="none" stroke="#ffffff14"/><text x="80" y="49" font-size="11" fill="#A8A29E">Active</text>
  <rect x="134" y="35" width="70" height="20" rx="10" fill="none" stroke="#ffffff14"/><text x="144" y="49" font-size="11" fill="#A8A29E">Favorites</text>
  <text x="380" y="49" font-size="10.5" fill="#6E6A63">Group <tspan fill="#E7E5E4" font-weight="600">Project</tspan>  Sort <tspan fill="#E7E5E4" font-weight="600">Last active</tspan></text>
  <rect x="1" y="70" width="598" height="24" fill="#111828"/><circle cx="18" cy="82" r="3.5" fill="#a78bfa"/><text x="30" y="86" font-size="10.5" font-family="ui-monospace,monospace" fill="#c4b5fd">PREVIOUS · RESUMABLE</text>
  <text x="380" y="120" font-size="10.5" fill="#f87171">✕ no PRIX / AGENTS-CLI project sections — the Group control is dead</text>
</svg>
</section>

<section data-state="proposed" data-evidence="mockup">
<svg viewBox="0 0 600 210" xmlns="http://www.w3.org/2000/svg" font-family="Geist, system-ui, sans-serif">
  <text x="0" y="12" font-size="10.5" font-family="ui-monospace, monospace" letter-spacing="0.5" fill="#84cc16">PROPOSED — STATUS CHIPS + REAL GROUPING (PROJECT / DEVICE / STATUS)</text>
  <rect x="0.5" y="22.5" width="599" height="186" rx="10" fill="#0a0a0a" stroke="#1b2334"/>
  <!-- status chips -->
  <rect x="14" y="35" width="42" height="20" rx="10" fill="#1a1a1a" stroke="#ffffff26"/><text x="22" y="49" font-size="11" fill="#E7E5E4">All</text>
  <rect x="62" y="35" width="56" height="20" rx="10" fill="none" stroke="#2c4a1c"/><circle cx="72" cy="45" r="3" fill="#4ade80"/><text x="80" y="49" font-size="11" fill="#A8A29E">Active</text>
  <rect x="124" y="35" width="50" height="20" rx="10" fill="none" stroke="#3a2e12"/><circle cx="134" cy="45" r="3" fill="#f5b544"/><text x="142" y="49" font-size="11" fill="#A8A29E">Idle</text>
  <rect x="180" y="35" width="62" height="20" rx="10" fill="none" stroke="#3a1c1c"/><circle cx="190" cy="45" r="3" fill="#f87171"/><text x="198" y="49" font-size="11" fill="#A8A29E">Blocked</text>
  <rect x="248" y="35" width="70" height="20" rx="10" fill="none" stroke="#ffffff14"/><text x="258" y="49" font-size="11" fill="#A8A29E">Favorites</text>
  <text x="392" y="49" font-size="10.5" fill="#6E6A63">Group <tspan fill="#E7E5E4" font-weight="600">Project ▾</tspan>  Sort <tspan fill="#E7E5E4" font-weight="600">Last active</tspan></text>
  <text x="392" y="63" font-size="9" fill="#5c6675">Project · Device · Status · None</text>
  <!-- grouped sections that actually split -->
  <rect x="1" y="74" width="598" height="22" fill="#111828"/><text x="16" y="88" font-size="10.5" font-family="ui-monospace,monospace" fill="#5eead4">▸ PRIX</text><text x="70" y="88" font-size="10.5" font-family="ui-monospace,monospace" fill="#5c6675">3</text>
  <text x="120" y="88" font-size="9.5" fill="#5c6675">2 active · 1 idle</text>
  <rect x="1" y="118" width="598" height="22" fill="#111828"/><text x="16" y="132" font-size="10.5" font-family="ui-monospace,monospace" fill="#5eead4">▸ AGENTS-CLI</text><text x="106" y="132" font-size="10.5" font-family="ui-monospace,monospace" fill="#5c6675">5</text>
  <text x="160" y="132" font-size="9.5" fill="#5c6675">1 blocked · 4 previous</text>
  <rect x="1" y="162" width="598" height="22" fill="#111828"/><text x="16" y="176" font-size="10.5" font-family="ui-monospace,monospace" fill="#5eead4">▸ FASTWISPR</text><text x="108" y="176" font-size="10.5" font-family="ui-monospace,monospace" fill="#5c6675">2</text>
  <text x="392" y="176" font-size="9.5" fill="#84cc16">✓ switch Group → Device or Status to re-bucket the same rows</text>
</svg>
</section>
</figure>

## Current architecture

All of this is render-layer in `SessionsPane.tsx` reading the streamed `FloorAgent`,
except two data gaps worth calling out. The row already carries `prUrl`; a repo URL and
a Linear ticket URL are derivable (repo from `prUrl`; Linear from the ticket id + the
workspace). The **real first user message** may not be on the stream — `prompt`/`topic`
can be a slash-command header — so #1 may need a `firstUserMessage` field added to the
CLI's `SessionWatchRow` (backfilled from the index, the way `version` landed), never a
side-channel fetch here.

<figure class="artifact-figure artifact-figure-diagram">
<figcaption>Where each fix lives. Green = render-only; amber = needs one CLI field.</figcaption>
<svg viewBox="0 0 700 150" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui" font-size="12">
  <rect x="16" y="50" width="150" height="50" rx="8" fill="#0f1625" stroke="#1b2334"/><text x="91" y="72" text-anchor="middle" fill="#E7E5E4" font-weight="600">SessionWatchRow</text><text x="91" y="89" text-anchor="middle" fill="#f5b544" font-size="10">+ firstUserMessage (#1)</text>
  <rect x="260" y="20" width="170" height="46" rx="8" fill="#0d1a12" stroke="#2c4a1c"/><text x="345" y="40" text-anchor="middle" fill="#a3e635" font-weight="600">SessionRow (render)</text><text x="345" y="56" text-anchor="middle" fill="#8b94a6" font-size="10">logo-only, timing, links, group</text>
  <rect x="260" y="86" width="170" height="46" rx="8" fill="#0d1a12" stroke="#2c4a1c"/><text x="345" y="106" text-anchor="middle" fill="#a3e635" font-weight="600">ExpandedCard (render)</text><text x="345" y="122" text-anchor="middle" fill="#8b94a6" font-size="10">request, meta, one Resume</text>
  <rect x="520" y="50" width="160" height="50" rx="8" fill="#0d1220" stroke="#a3e635" stroke-width="1.4"/><text x="600" y="79" text-anchor="middle" fill="#a3e635" font-weight="700">Sessions view</text>
  <line x1="166" y1="66" x2="256" y2="46" stroke="#8b94a6" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="166" y1="84" x2="256" y2="108" stroke="#8b94a6" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="430" y1="46" x2="518" y2="66" stroke="#8b94a6" stroke-width="1.4" marker-end="url(#ar)"/>
  <line x1="430" y1="108" x2="518" y2="84" stroke="#8b94a6" stroke-width="1.4" marker-end="url(#ar)"/>
  <defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L8,4.5 L0,9 z" fill="#8b94a6"/></marker></defs>
</svg>
</figure>

## Interaction spec — every clickable thing

| Element | Click does | Notes |
|---|---|---|
| Row body / `⌃` | Expand / collapse | The only expand trigger |
| Ticket `◇ PHNX-####` | Open in **Linear** (`↗`) | falls back to copy-id if no URL |
| PR `PR #NN` | Open the **GitHub PR** (`↗`) | from `prUrl` |
| Repo `▪ prix` | Open the **GitHub repo** (`↗`) | derived from `prUrl` |
| Branch `⑂ main` | **Copy** (`⧉`) | no natural URL |
| `Resume` (normal button) | Reopen the session on the device it ran on | plain, compact — same as the row's Resume |
| `Resume` right-click | Context menu: **Resume on a different device…** (+ pick a device) | the power case, out of the way |
| Group `Project ▾` | Re-bucket into Project / Device / Status / None | headers split the list for real |
| Status chip | Filter to active / idle / blocked | dot color encodes status |

## Status model

| Status | Dot | Means | Chip / group |
|---|---|---|---|
| `active` | green | working, making progress | Active |
| `idle` | amber | running but stopped — waiting on your input or a permission prompt | Idle |
| `waiting` | amber | waiting on a tool / CI to return | (folds into Idle unless you want it split) |
| `blocked` | red | needs a decision only you can make | Blocked |
| `previous` | grey | ended, resumable from transcript | (the Previous band) |

## Timing model

- **Row age**: always relative to last activity — `9m ago`, `2h ago`, `3d ago`.
- **Card meta**: `Ran <duration> · ended <relative> ago`, with the absolute range
  (`Aug 30, 4:42–4:44 PM`) on hover. `duration = lastActivity − started`; when it's <1m
  show `Ran <1m`. Never show two identical timestamps.

## Proposed Changes

```diff
# SessionRow header — logo carries identity; drop the redundant agent-name text
- <span className="sx-agent">{agentId}</span>
- {a.project && <span className="sx-proj">{a.project}</span>}
- <span className="sx-ttl">{row.title}</span>
+ {a.project && <span className="sx-proj">{a.project}</span>}
+ <span className="sx-ttl">{row.title}</span>   {/* the avatar already shows who */}
```

```diff
# Pills navigate instead of copy-or-nothing
- {a.ticket && <span className="sx-chip ticket" onClick={(e)=>copyPill(e,a.ticket!)}>◇ {a.ticket}</span>}
+ {a.ticket && <PillLink kind="ticket" href={linearUrl(a.ticket)} onCopyFallback={a.ticket}>◇ {a.ticket}</PillLink>}
+ {row.repo && <PillLink kind="repo" href={repoUrl(a.prUrl)}>▪ {row.repo}</PillLink>}
```

```diff
# Grouping: make Group actually bucket the Previous list too (not just live)
- buildSessionSections(scoped, 'flat', ...)          // previous always flat
+ buildSessionSections(scoped, group, sort, desc)    // honor Project | Device | Status | None
```

## Public Interface

- Row: logo only (no agent-name text); title is the recap; age is relative (`9m ago`).
- Expanded card: `YOUR REQUEST` (real first user message + See more) · `SESSION`
  (`Ran … · ended … ago`, device once) · `LINKS` (ticket→Linear, PR/repo→GitHub,
  branch→copy) · one `Resume on <device>`.
- List: status chips `All · Active · Idle · Blocked · Favorites`; Group `Project ·
  Device · Status · None` that splits the list; Sort unchanged.
- If `firstUserMessage` is missing from the stream, it is added to the CLI row.

## Plan

| # | Task | File(s) |
|---|------|---------|
| 1 | Refactor `SessionsPane.tsx`: extract `SessionRow`, `ExpandedCard`, `RowLinks`, `SessionMeta` components; consolidate the duplicated `SESSION_ROW_CSS`/`CSS3` | `SessionsPane.tsx` (+ new files) |
| 2 | Logo-only header; relative-age helper; `Ran … · ended … ago` meta with hover | `SessionsPane.tsx`, `recapModel.ts` |
| 3 | `PillLink` — ticket→Linear, PR/repo→GitHub (via `openExternal` bridge), branch→copy | `SessionsPane.tsx` |
| 4 | Device shown once; single `Resume on <device>` with subtitle; drop `Resume here` | `SessionsPane.tsx` |
| 5 | Status model + status chips + Group by Project/Device/Status/None (make Previous honor grouping) | `floorModel.ts`, `sessionsModel.ts`, `SessionsPane.tsx` |
| 6 | `firstUserMessage` on the stream if `prompt`/`topic` is a header (CLI + adapter) | agents-cli `SessionWatchRow`, `remoteSessions.vscode.ts` |
| 7 | Tests for each; `bun test` + `compile:ext` green; verify in VS Code, screenshot | `*.test.tsx` |

## Validation

- Unit: relative-age + duration formatting; `PillLink` opens the right URL and
  stops propagation; grouping buckets Previous rows by Project/Device/Status;
  logo-only header has no agent-name text.
- Visual (VS Code, installed): expand a codex row → YOUR REQUEST shows the real prompt
  with See more; SESSION reads `Ran … · ended … ago`; clicking the repo pill opens
  GitHub; switching Group re-buckets. Screenshot each.

## Risks

- `firstUserMessage`: if the CLI genuinely can't supply it, THE ASK falls back to the
  best available (topic/prompt) and we label it honestly — never invent text.
- Linear URL needs the workspace slug; if absent, ticket pill copies the id instead of
  a dead link.
- Grouping the Previous band by Status must not double-count a row across sections.

## Tracking

- [PHNX-3621](https://linear.app/issue/PHNX-3621) — implemented on `agents/prevsessions-followup`.
- PR #23 is already merged; this follow-up ships in a new PR from the same branch.
- Verified in the product-faithful browser preview on zion with expanded-request, Previous timing, grouping, and alternate-device Resume screenshots.
