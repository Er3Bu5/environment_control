/* The Automations pages, drawn as the design mock draws them: a zone's Automations page with its three chips, Link
   automations, Setup's Alerts card and the zone page's notice that a failsafe is off. Each function only draws what
   it's handed and calls back on a tap; main.ts holds the state, the foot bars and the dialogs. Rows reuse the markup
   of a Controls row and of Device identification's pick rows, so they need no styles of their own. Names, areas and
   entity ids come from Home Assistant and are only ever bound as text. */
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { type AutoChip, type AutoIcon, type AutoRow, CHIP, type ChipView, GROUP, type GroupView, type LinkRow, type RepeatCard, emptyText } from "./automations";
import { AUTOMATION_GROUPS, type AutomationGroup, type AutomationLink, type Zone } from "./model";

/* Drawing helpers main.ts owns, handed in rather than copied: an icon by name, and its radio chips. */
export type DrawIcon = (name: AutoIcon) => unknown;
export type Chips = (legend: string, name: string, options: { value: string; label: string }[], current: string, pick: (v: string) => void) => unknown;

export const linkTarget = (entity: string) => `lk-${entity.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/* An automation's row, as a Controls row is drawn: its icon lit while HA reports it on, what HA reports and when it
   last ran, the switch, and under it what a tap is waiting for or why it wasn't sent. */
export function autoRowView(r: AutoRow, mark: AutoIcon, icon: DrawIcon, onTap: (link: AutomationLink) => void) {
  return html`<div class="dev" data-auto=${r.link.entity}>
    <span class="ic" style="--c:${r.on ? "var(--primary)" : "var(--off)"}">${icon(mark)}</span>
    <div class="dev-text">
      <div class="dev-name">${r.name}</div>
      <div class="dev-sub">${r.sub}</div>
    </div>
    <div class="dev-ctl">
      <button class="sw ${r.on ? "on" : ""}" role="switch" aria-checked=${r.on ? "true" : "false"} aria-label=${r.name} ?disabled=${r.locked} @click=${() => onTap(r.link)}><i></i></button>
    </div>
    ${r.line ? html`<div class="ctl-status ${r.line.tone}" role="status">${r.line.text}</div>` : nothing}
  </div>`;
}

/* The Alerts chip's first card: the one helper every alert's repeat rate comes from. Typing changes only the draft. */
export function repeatCardView(card: RepeatCard, onType: (typed: string) => void, onLinkOnSetup: () => void) {
  if (card.kind === "unlinked")
    return html`<section class="card" id="alert-repeat">
      <h2>Alert repeat</h2>
      <p class="small muted">How often an alert may buzz your phone comes from one Home Assistant helper shared by every alert. Link it on Setup to change it here.</p>
      <button class="fixlink" @click=${onLinkOnSetup}>Link it on Setup &rsaquo;</button>
    </section>`;
  if (card.kind === "missing")
    return html`<section class="card" id="alert-repeat">
      <h2>Alert repeat</h2>
      <p class="small muted">Home Assistant doesn't have ${card.entity} right now, so it can't be changed.</p>
    </section>`;
  /* Text with a number keyboard, as every typed number on the panel is: a number box drops what it can't parse
     without a word, and the problem line says why instead. */
  const whole = !card.limits || Number.isInteger(card.limits.step);
  return html`<section class="card" id="alert-repeat">
    <h2>Alert repeat</h2>
    <p class="small muted">While an alert stays breached, it buzzes your phone at most once every this many minutes, and 0 buzzes on every update. One helper sets it for every alert in Home Assistant, irrigation and power included.</p>
    <label class="field" for="repeat-in"
      >Minutes between buzzes<input
        id="repeat-in"
        type="text"
        inputmode=${whole ? "numeric" : "decimal"}
        enterkeyhint="done"
        autocomplete="off"
        data-lin="repeat"
        .value=${live(card.value)}
        aria-invalid=${card.problem ? "true" : "false"}
        aria-describedby="repeat-bad"
        @input=${(e: Event) => onType((e.target as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    /></label>
    <p class="small crit-text" id="repeat-bad" ?hidden=${!card.problem}>${card.problem}</p>
    <p class="small muted">On your helper, ${card.entity}.</p>
  </section>`;
}

export interface AutomationsPageView {
  zone: Zone;
  chip: AutoChip;
  chips: ChipView[];
  groups: GroupView[];
  row: (link: AutomationLink) => AutoRow;
  /* The Alert repeat card, drawn on the Alerts chip only. */
  repeat: RepeatCard;
  icon: DrawIcon;
  onChip: (chip: AutoChip) => void;
  onTap: (link: AutomationLink) => void;
  onLink: () => void;
  onRepeat: (typed: string) => void;
  onLinkOnSetup: () => void;
}

/* One page per zone: the chips with what's on in each, the picked chip's about sentence, on Alerts the repeat card,
   then a card per group that links anything, or a notice that the chip links nothing yet. Back rides in main.ts's
   bar at the foot of the window. */
export function automationsPage(o: AutomationsPageView) {
  const mark = CHIP[o.chip].icon;
  return html`<div>
      <h1>Automations: ${o.zone.name}</h1>
      <p class="muted small">Home Assistant runs these. Here you switch them on and off.</p>
    </div>
    <div class="seg" role="group" aria-label="Automations">
      ${o.chips.map(
        (c) => html`<button aria-pressed=${c.chip === o.chip ? "true" : "false"} aria-label=${c.label} @click=${() => c.chip !== o.chip && o.onChip(c.chip)}>
          ${c.title} <small class="muted">${c.count}</small>
        </button>`,
      )}
    </div>
    <p class="muted small">${CHIP[o.chip].about}</p>
    ${o.chip === "alert" ? repeatCardView(o.repeat, o.onRepeat, o.onLinkOnSetup) : nothing}
    ${o.groups.length
      ? html`${o.groups.map(
            (g) => html`<section class="card" data-agroup=${g.group}>
              <div class="card-head"><h2>${g.title}</h2><span class="small muted">${g.count}</span></div>
              <div class="devs">${repeat(g.links, (a) => a.id, (a) => autoRowView(o.row(a), mark, o.icon, o.onTap))}</div>
            </section>`,
          )}
          <div class="row"><button class="btn" @click=${o.onLink}>Link automations</button></div>`
      : html`<div class="notice calm">
          <strong>${emptyText(o.chip, o.zone.name)}</strong><button class="fixlink" @click=${o.onLink}>Link automations &rsaquo;</button>
        </div>`}`;
}

export interface LinkPageView {
  zone: Zone;
  /* null until Home Assistant's list is in hand; error says why there's none at all. */
  list: { rows: LinkRow[]; more: number } | null;
  error: string | null;
  q: string;
  chips: Chips;
  onRetry: () => void;
  onQuery: (q: string) => void;
  onTick: (row: LinkRow) => void;
  onGroup: (entity: string, group: AutomationGroup) => void;
}

/* A picked row opens to its group, chosen with radio chips, as a picked device opens to what it is. */
function linkRowView(r: LinkRow, o: LinkPageView) {
  const picked = r.group !== null;
  return html`<div class="pickwrap" id=${linkTarget(r.entity)}>
    <button class="pickrow" aria-pressed=${picked ? "true" : "false"} @click=${() => o.onTick(r)}>
      <span class="tick">${picked ? "✓" : ""}</span>
      <span class="pick-text"><strong>${r.name}</strong><span class="dev-sub">${r.sub}</span></span>
      <span class="pill plain">${r.pill}</span>
    </button>
    ${picked
      ? html`<div class="ents">
          ${o.chips("Group", `lgroup-${r.entity}`, AUTOMATION_GROUPS.map((g) => ({ value: g, label: GROUP[g].title })), r.group ?? "", (v) => o.onGroup(r.entity, v as AutomationGroup))}
        </div>`
      : nothing}
  </div>`;
}

/* Link automations: a search box over Home Assistant's automations, and the zone's picks with their groups. Its foot
   bar, Back and, with changes, the count, Discard and Review and apply, is main.ts's. */
export function linkPage(o: LinkPageView) {
  const head = html`<div>
    <h1>Link automations: ${o.zone.name}</h1>
    <p class="muted small">
      Pick the automations ${o.zone.name} should switch, and put each in a group. The group is suggested from the automation's name, so change it if yours follow other names. Home Assistant keeps running them either way.
    </p>
  </div>`;
  if (!o.list)
    return html`${head}<section class="card">
        ${o.error
          ? html`<div class="notice"><span>${o.error}</span><button class="btn" @click=${o.onRetry}>Try again</button></div>`
          : html`<p class="muted">Reading Home Assistant's automations.</p>`}
      </section>`;
  const { rows, more } = o.list;
  return html`${head}<section class="card">
      <label class="field" for="link-q"
        >Search Home Assistant<input
          id="link-q"
          type="search"
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="search"
          placeholder="Name or entity id"
          .value=${live(o.q)}
          @input=${(e: Event) => o.onQuery((e.target as HTMLInputElement).value)}
      /></label>
      <div class="picklist" id="link-list">
        ${rows.length ? repeat(rows, (r) => r.entity, (r) => linkRowView(r, o)) : html`<p class="muted small">No automation matches.</p>`}
        ${more
          ? html`<p class="small muted" id="link-more">${o.q.trim() ? `${more} more match. Type more of the name to narrow them down.` : `${more} more in Home Assistant. Search to find them.`}</p>`
          : nothing}
      </div>
    </section>`;
}

export interface AlertsCardView {
  /* The room's helper and what the card says of it, or null while none is linked. */
  entity: string | null;
  text: string;
  picking: boolean;
  busy: boolean;
  /* main.ts's helper search box, shown while picking. */
  picker: unknown;
  onPick: () => void;
  onUnlink: () => void;
}

/* Setup's Alerts card, above Appearance: the one helper every alert's repeat rate comes from, linked for the room. */
export function alertsCard(o: AlertsCardView) {
  return html`<section class="card" id="room-alerts">
    <div>
      <h2>Alerts</h2>
      <p class="small muted">How often an alert may buzz your phone comes from one number helper shared by every alert in Home Assistant, so it's linked here, for the whole room, rather than per zone.</p>
    </div>
    ${o.entity
      ? html`<div class="task">
          <div><strong>Alert repeat</strong><p class="small muted">${o.text}</p></div>
          <div class="row">
            <button class="btn" aria-expanded=${o.picking ? "true" : "false"} ?disabled=${o.busy} @click=${o.onPick}>Link another</button>
            <button class="btn" ?disabled=${o.busy} @click=${o.onUnlink}>Unlink</button>
          </div>
        </div>`
      : html`<div class="row"><button class="btn primary" aria-expanded=${o.picking ? "true" : "false"} ?disabled=${o.busy} @click=${o.onPick}>Link a helper</button></div>`}
    ${o.picking ? o.picker : nothing}
  </section>`;
}

/* Near the top of the zone page while any failsafe is off. It opens the Automations page on Failsafes. */
export function failsafeNoticeView(text: string | null, onOpen: () => void) {
  return text ? html`<button class="notice fix" @click=${onOpen}><span>${text}</span><span class="fixgo">Failsafes &rsaquo;</span></button>` : nothing;
}
