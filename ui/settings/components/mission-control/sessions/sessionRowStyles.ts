// One Sessions-row stylesheet. Keeping the cascade in a single owned module makes
// layout changes visible together instead of hiding them in numbered override blocks.
export const SESSION_ROW_CSS = `
.sw-sessions .sx-band {
  display: flex; align-items: center; gap: 9px; padding: 9px 14px; height: auto;
  box-sizing: border-box;
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace;
  font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase;
  color: #8b94a6; background: #111828; border-bottom: 1px solid #1b2334; border-top: 0;
}
.sw-sessions .sx-band .g { width: 7px; height: 7px; border-radius: 50%; background: #a78bfa; font-size: 0; color: transparent; }
.sw-sessions .sx-band .lab { letter-spacing: 1.2px; color: #8b94a6; }
.sw-sessions .sx-band .cnt { color: #5c6675; font-size: 11px; letter-spacing: 0; text-transform: none; }
.sw-sessions .sx-band-act {
  margin-left: auto; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace;
  font-size: 11.5px; color: #a3e635; letter-spacing: 0; text-transform: none; font-weight: 400;
  border: 1px solid #34401a; background: #161e0b; border-radius: 6px; padding: 3px 10px;
}
.sw-sessions .sx-row {
  display: flex; align-items: flex-start; gap: 11px;
  padding: 12px 14px; cursor: default; overflow: hidden;
  box-sizing: border-box; width: 100%;
  border-top: 0; border-bottom: 1px solid #1b2334;
  grid-template-columns: none;
}
.sw-sessions .sx-row:last-child { border-bottom: none; }
.sw-sessions .sx-row:hover { background: #0f1625; }
.sw-sessions .sx-row.sel { background: rgba(163, 230, 53, 0.06); }
.sw-sessions .sx-row.active { background: #0f1625; }
.sw-sessions .sx-cb { flex: none; margin-top: 2px; width: 14px; height: 14px; border: 1.5px solid #5c6675; border-radius: 3px; background: transparent; }
.sw-sessions .sx-cb.on { background: #a3e635; border-color: #a3e635; }
.sw-sessions .sx-star { flex: none; margin-top: 1px; color: #5c6675; font-size: 13px; }
.sw-sessions .sx-star.on { color: #f5c518; }
.sw-sessions .sx-pdot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; flex: none; margin-top: 5px; }
.sw-sessions .sx-pdot.off { background: #5c6675; }
.sw-sessions .sx-grow { min-width: 0; flex: 1; }
.sw-sessions .sx-titleline { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sw-sessions .sx-ttl { color: #e6e9ef; font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-sessions .sx-src { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 9.5px; letter-spacing: .3px; text-transform: uppercase; padding: 1px 5px; border-radius: 4px; flex: none; }
.sw-sessions .sx-src.agent { color: #4ade80; background: #0d2417; border: 1px solid #1c4a2f; }
.sw-sessions .sx-src.last { color: #6ea8fe; background: #0c1a2e; border: 1px solid #1c3a5a; }
.sw-sessions .sx-src.rename { color: #a78bfa; background: #1a1430; border: 1px solid #342a52; }
.sw-sessions .sx-roleline { display: flex; align-items: flex-start; gap: 9px; margin-top: 3px; font-size: 12.5px; }
.sw-sessions .sx-roletag { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 10.5px; font-weight: 700; flex: none; width: 62px; text-align: right; padding-top: 1px; letter-spacing: .2px; white-space: nowrap; }
.sw-sessions .sx-roletag.you { color: #6ea8fe; }
.sw-sessions .sx-roletag.agent { color: #d97757; }
.sw-sessions .sx-rolebody { min-width: 0; flex: 1; color: #8b94a6; }
.sw-sessions .sx-rolebody.clip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-sessions .sx-expand { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: #5eead4; cursor: pointer; margin-left: 6px; background: none; border: 0; padding: 0; }
.sw-sessions .sx-expand:hover { color: #a3e635; }
.sw-sessions .sx-imgchip, .sw-sessions .sx-cmdchip, .sw-sessions .sx-slashchip {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px;
  border-radius: 5px; padding: 0 6px; margin-right: 5px;
}
.sw-sessions .sx-imgchip { color: #5eead4; background: #0c1a20; border: 1px solid #123; }
.sw-sessions .sx-cmdchip { color: #f5b544; background: #1c1608; border: 1px solid #3a2e12; }
.sw-sessions .sx-slashchip { color: #a78bfa; background: #160f28; border: 1px solid #2a2050; }
.sw-sessions .sx-full { margin: 6px 0 2px 71px; padding: 9px 11px; border-left: 2px solid #223; background: #0b101c; border-radius: 0 7px 7px 0; color: #8b94a6; font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
.sw-sessions .sx-metarow { display: flex; align-items: center; gap: 7px; margin-top: 8px; flex-wrap: wrap; padding-left: 71px; }
.sw-sessions .sx-metarow .sx-chip { display: inline-flex; align-items: center; gap: 5px; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; padding: 1.5px 7px; border-radius: 5px; border: 1px solid #1b2334; color: #8b94a6; white-space: nowrap; background: #0c1220; }
.sw-sessions .sx-metarow .sx-chip.repo { color: #5eead4; border-color: #123; }
.sw-sessions .sx-metarow .sx-chip.pr { color: #a3e635; border-color: #2c3a16; background: #141c0a; }
.sw-sessions .sx-metarow .sx-chip.pr .ci { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; display: inline-block; }
.sw-sessions .sx-metarow .sx-chip.pr .ci.run { background: #f5b544; }
.sw-sessions .sx-metarow .sx-chip.pr .ci.fail { background: #f87171; }
.sw-sessions .sx-metarow .sx-chip.branch { color: #a78bfa; border-color: #241d3a; }
.sw-sessions .sx-metarow .sx-chip.host { color: #8b94a6; }
.sw-sessions .sx-metarow .sx-chip.nopr { color: #5c6675; }
.sw-sessions .sx-rowactions { display: flex; align-items: center; gap: 10px; flex: none; margin-top: 0; }
.sw-sessions button { appearance: none; font-family: inherit; }
.sw-sessions .sx-resumebtn {
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: #a3e635;
  border: 1px solid #34401a; background: #161e0b; border-radius: 6px; padding: 3px 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
.sw-sessions .sx-resumebtn:hover { background: #1e2a0d; border-color: #4a5a24; }
.sw-sessions .sx-age { color: #5c6675; font-size: 12px; flex: none; width: 34px; text-align: right; margin-top: 1px; }
.sw-sessions .sx-live { width: 10px; height: 10px; border-radius: 50%; background: #4ade80; flex: none; margin-top: 4px; box-shadow: 0 0 6px #4ade8066; }
.sw-sessions .sx-live.idle { background: #f5b544; box-shadow: 0 0 6px #f5b54455; }
.sw-sessions .sx-live.done { background: #5c6675; box-shadow: none; }
.sw-sessions .sx-live.orphan { background: #a78bfa; box-shadow: 0 0 6px #a78bfa66; }
@media (max-width: 720px) {
  .sw-sessions .sx-row { gap: 7px; padding: 9px 10px; }
  .sw-sessions .sx-cb, .sw-sessions .sx-star { display: none; }
  .sw-sessions .sx-roletag { width: 48px; }
  .sw-sessions .sx-metarow { padding-left: 57px; }
  .sw-sessions .sx-rowactions { gap: 6px; }
  .sw-sessions .sx-resumebtn { padding: 3px 6px; }
  .sw-sessions .sx-resumelabel { display: none; }
  .sw-sessions .sx-age { width: 28px; font-size: 10px; }
}
.sw-sessions .sx-band { background: var(--ds-bg-sunken, #111828); color: var(--ds-text-dim, #8b94a6); border-bottom-color: var(--ds-border, #1b2334); }
.sw-sessions .sx-band .lab { color: var(--ds-text, #e6e9ef); font-weight: 600; }
.sw-sessions .sx-band .cnt { color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-band .g { background: var(--brand, #a3e635); border-radius: 3px; }
.sw-sessions .sx-band.recon .g { background: #a78bfa; }
.sw-sessions .sx-band-act { color: var(--brand, #a3e635); background: rgba(163,230,53,.12); border-color: var(--brand, #a3e635); }
.sw-sessions .sx-row { border-bottom-color: var(--ds-border, #1b2334); }
.sw-sessions .sx-row:hover { background: rgba(127,140,160,0.07); }
.sw-sessions .sx-row.active { background: rgba(127,140,160,0.10); }
.sw-sessions .sx-ttl { color: var(--ds-text, #e6e9ef); }
.sw-sessions .sx-rolebody { color: var(--ds-text-dim, #8b94a6); }
.sw-sessions .sx-full { background: var(--ds-bg-sunken, #0b101c); color: var(--ds-text-dim, #8b94a6); border-left-color: var(--ds-border, #223); margin-left: 49px; }
.sw-sessions .sx-metarow { padding-left: 49px; }
.sw-sessions .sx-metarow .sx-chip { background: var(--ds-bg-sunken, #0c1220); border-color: var(--ds-border, #1b2334); color: var(--ds-text-dim, #8b94a6); }
.sw-sessions .sx-metarow .sx-chip.pr { color: var(--brand, #a3e635); background: rgba(163,230,53,.08); border-color: rgba(163,230,53,.3); }
.sw-sessions .sx-metarow .sx-chip.ticket { color: #a78bfa; border-color: rgba(167,139,250,.3); }
.sw-sessions .sx-metarow .sx-chip.repo { color: #2aa899; border-color: rgba(94,234,212,.3); }
.sw-sessions .sx-metarow .sx-chip.branch { color: #a78bfa; border-color: rgba(167,139,250,.25); }
.sw-sessions .sx-metarow .sx-chip.host, .sw-sessions .sx-metarow .sx-chip.nopr { color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-src.agent { background: rgba(74,222,128,.12); border-color: rgba(74,222,128,.3); }
.sw-sessions .sx-src.last { background: rgba(110,168,254,.12); border-color: rgba(110,168,254,.3); }
.sw-sessions .sx-src.rename { background: rgba(167,139,250,.12); border-color: rgba(167,139,250,.3); }
.sw-sessions .sx-imgchip { background: rgba(94,234,212,.1); border-color: rgba(94,234,212,.28); }
.sw-sessions .sx-cmdchip { background: rgba(245,181,68,.12); border-color: rgba(245,181,68,.3); }
.sw-sessions .sx-slashchip { background: rgba(167,139,250,.12); border-color: rgba(167,139,250,.3); }
.sw-sessions .sx-resumebtn { color: var(--brand, #a3e635); background: rgba(163,230,53,.12); border-color: var(--brand, #a3e635); }
.sw-sessions .sx-resumebtn:hover { background: rgba(163,230,53,.2); }
.sw-sessions .sx-age { color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-cb { border-color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-cb.on { background: var(--brand, #a3e635); border-color: var(--brand, #a3e635); }
.sw-sessions .sx-star { color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-av { flex: none; margin-top: 1px; }
.sw-sessions .sx-roletag { width: 40px; }
.sw-sessions .sx-titleline { margin-bottom: 3px; gap: 7px; }
.sw-sessions .sx-proj { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 10.5px; color: var(--brand, #a3e635); font-weight: 700; letter-spacing: .4px; text-transform: uppercase; flex: none; }
.sw-sessions .sx-phase { margin-left: auto; flex: none; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 9.5px; letter-spacing: .3px; text-transform: uppercase; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--ds-border, #1b2334); color: var(--ds-text-dim, #8b94a6); white-space: nowrap; }
.sw-sessions .sx-phase.running { color: #6ea8fe; border-color: rgba(110,168,254,.4); background: rgba(110,168,254,.10); }
.sw-sessions .sx-phase.idle, .sw-sessions .sx-phase.waiting { color: #d98a2b; border-color: rgba(245,181,68,.45); background: rgba(245,181,68,.14); }
.sw-sessions .sx-phase.failed { color: #dc4b4b; border-color: rgba(248,113,113,.45); background: rgba(248,113,113,.14); }
.sw-sessions .sx-phase.done { color: #2f9e5a; border-color: rgba(74,222,128,.4); background: rgba(74,222,128,.10); }
.sw-sessions .sx-phase.needs { color: #dc4b4b; border-color: rgba(248,113,113,.55); background: rgba(248,113,113,.16); font-weight: 700; }
.sw-sessions .sx-now { font-size: 12px; color: var(--ds-text-dim, #8b94a6); margin: 0 0 4px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-sessions .sx-now b { color: var(--ds-text, #e6e9ef); font-weight: 600; }
.sw-sessions .sx-band.previous .g { background: #a78bfa; }
.sw-sessions .sx-band-more {
  margin-left: 8px; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px;
  color: var(--ds-text-dim, #8b94a6); background: none; border: 0; cursor: pointer; letter-spacing: 0; text-transform: none;
}
.sw-sessions .sx-band-more:hover { color: var(--brand, #a3e635); }
.sw-sessions .sx-metarow .sx-chip.attach { color: #5eead4; border-color: rgba(94,234,212,.28); }
.sw-sessions .sx-metarow .sx-chip.art { color: #f5b544; border-color: rgba(245,181,68,.3); }
.sw-sessions .sx-viewbtn {
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: var(--ds-text-dim, #8b94a6);
  border: 1px solid var(--ds-border, #2a3550); background: transparent; border-radius: 6px; padding: 3px 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
.sw-sessions .sx-viewbtn:hover { color: var(--ds-text, #e6e9ef); border-color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-detail { margin: 6px 0 4px 49px; display: flex; flex-direction: column; gap: 12px; }
.sw-sessions .sx-dsec { display: flex; flex-direction: column; gap: 6px; }
.sw-sessions .sx-dcap { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-ask { color: var(--ds-text-dim, #8b94a6); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; padding: 8px 11px; border-left: 2px solid var(--ds-border, #223); background: var(--ds-bg-sunken, #0b101c); border-radius: 0 7px 7px 0; max-height: 140px; overflow-y: auto; }
.sw-sessions .sx-goal { color: var(--ds-text-muted, #5c6675); font-size: 12px; font-style: italic; }
.sw-sessions .sx-goal b { color: var(--ds-text-dim, #8b94a6); font-style: normal; }
.sw-sessions .sx-endedmeta { color: var(--ds-text-dim, #8b94a6); font-size: 12px; padding: 6px 10px; border-left: 2px solid var(--ds-border, #223); background: var(--ds-bg-sunken, #0b101c); border-radius: 0 7px 7px 0; }
/* Copy-on-click metadata pills — clearly interactive, and they never expand the row. */
.sw-sessions .sx-chip[role="button"], .sw-sessions .sx-catch .lnk[role="button"] { cursor: pointer; }
.sw-sessions .sx-metarow .sx-chip[role="button"]:hover { border-color: var(--ds-text-muted, #5c6675); color: var(--ds-text, #e6e9ef); }
.sw-sessions .sx-actbar { display: flex; align-items: center; height: 8px; border-radius: 4px; overflow: hidden; background: var(--ds-bg-sunken, #0c1220); border: 1px solid var(--ds-border, #1b2334); }
.sw-sessions .sx-actbar i { height: 100%; }
.sw-sessions .sx-actbar i.reading { background: #6ea8fe; }
.sw-sessions .sx-actbar i.editing { background: #a3e635; }
.sw-sessions .sx-actbar i.agents { background: #a78bfa; }
.sw-sessions .sx-actbar i.idle { background: #3a4560; }
.sw-sessions .sx-actlegend { display: flex; gap: 12px; font-size: 10.5px; color: var(--ds-text-muted, #5c6675); margin-top: 2px; }
.sw-sessions .sx-actlegend span { display: inline-flex; align-items: center; gap: 4px; }
.sw-sessions .sx-actlegend .dot { width: 7px; height: 7px; border-radius: 2px; background: #3a4560; }
.sw-sessions .sx-actlegend .dot.reading { background: #6ea8fe; }
.sw-sessions .sx-actlegend .dot.editing { background: #a3e635; }
.sw-sessions .sx-actlegend .dot.agents { background: #a78bfa; }
.sw-sessions .sx-actlegend .dot.idle { background: #3a4560; }
.sw-sessions .sx-actspan { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--ds-text-muted, #5c6675); margin-top: 2px; }
.sw-sessions .sx-todo { display: flex; flex-direction: column; gap: 3px; }
.sw-sessions .sx-todo .it { display: flex; align-items: baseline; gap: 7px; font-size: 12.5px; color: var(--ds-text-dim, #8b94a6); }
.sw-sessions .sx-todo .it .mk { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 12px; flex: none; width: 12px; }
.sw-sessions .sx-todo .it.done .mk { color: #4ade80; } .sw-sessions .sx-todo .it.done .tx { text-decoration: line-through; color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-todo .it.cur .mk { color: #f5b544; } .sw-sessions .sx-todo .it.cur .tx { color: var(--ds-text, #e6e9ef); }
.sw-sessions .sx-todo .it.pend .mk { color: #5c6675; }
.sw-sessions .sx-catch { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sw-sessions .sx-catch a, .sw-sessions .sx-catch .lnk {
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: var(--ds-text-dim, #8b94a6);
  border: 1px solid var(--ds-border, #1b2334); border-radius: 5px; padding: 2px 8px; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
}
.sw-sessions .sx-catch a:hover, .sw-sessions .sx-catch .lnk:hover { color: var(--ds-text, #e6e9ef); border-color: var(--ds-text-muted, #5c6675); }
.sw-sessions .sx-thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.sw-sessions .sx-thumbs .th { width: 46px; height: 46px; border-radius: 6px; border: 1px solid var(--ds-border, #1b2334); object-fit: cover; background: var(--ds-bg-sunken, #0c1220); }
.sw-sessions .sx-thumbs .th.ph { display: inline-flex; align-items: center; justify-content: center; font-size: 16px; color: var(--ds-text-muted, #5c6675); }
/* PHNX-3593 layout hardening: the row is two tracks — a clipping content column and a
   fixed action column — so the Resume/View button + age + dot can never overlap the
   title or any inline pill, even in a narrow VS Code panel. */
.sw-sessions .sx-row { align-items: flex-start; gap: 10px; }
.sw-sessions .sx-grow { min-width: 0; overflow: hidden; }
.sw-sessions .sx-titleline { min-width: 0; flex-wrap: nowrap; overflow: hidden; }
.sw-sessions .sx-titleline .sx-ttl { min-width: 0; }
.sw-sessions .sx-rowactions {
  flex: 0 0 132px; width: 132px; box-sizing: border-box;
  justify-content: flex-end; align-self: flex-start; padding-left: 6px;
}
/* live phase pills ride beside the title, never pushed into the action column */
.sw-sessions .sx-phase { margin-left: 6px; }
@media (max-width: 720px) {
  .sw-sessions .sx-rowactions { flex-basis: 76px; width: 76px; padding-left: 0; }
}
.sx-resume-menu {
  position: fixed; z-index: 10000; width: 244px; box-sizing: border-box; padding: 6px;
  border: 1px solid var(--ds-border, #2a3550); border-radius: 8px;
  background: var(--ds-bg-raised, #151d2d); color: var(--ds-text, #e6e9ef);
  box-shadow: 0 12px 34px rgba(0,0,0,.42);
}
.sx-resume-menu-title {
  padding: 6px 8px 7px; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace;
  font-size: 10px; color: var(--ds-text-muted, #7b8699); letter-spacing: .25px;
}
.sx-resume-menu button {
  width: 100%; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 5px;
  padding: 7px 8px; color: var(--ds-text, #e6e9ef); background: transparent;
  font: 12px/1.2 inherit; text-align: left; cursor: pointer;
}
.sx-resume-menu button:hover:not(:disabled) { background: rgba(127,140,160,.13); }
.sx-resume-menu button:disabled { color: var(--ds-text-muted, #5c6675); cursor: default; }
.sx-resume-device-dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; flex: none; }
.sx-resume-device-dot.offline { background: #5c6675; }
.sx-resume-device-state { margin-left: auto; color: var(--ds-text-muted, #5c6675); font-size: 10px; }
.sx-resume-menu-empty { padding: 8px; color: var(--ds-text-muted, #5c6675); font-size: 12px; }
`
