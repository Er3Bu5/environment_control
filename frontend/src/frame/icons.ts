/* The panel's icons, drawn inline because the frame can't fetch anything. Paths as the design mock has them. */
import { svg } from "lit";

const PATHS = {
  menu: "M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 2.8l2.1 2.1-1.4 1.4-2.1-2.1zm15 15 2.1 2.1-1.4 1.4-2.1-2.1zM2.8 19.8l2.1-2.1 1.4 1.4-2.1 2.1zm15-15 2.1-2.1 1.4 1.4-2.1 2.1z",
  moon: "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.4 5.4 0 0 1-7.54-7.54A9 9 0 0 0 12 3Z",
  thermo: "M15 13V5a3 3 0 0 0-6 0v8a5 5 0 1 0 6 0Zm-3 7a3 3 0 0 1-1-5.8V5a1 1 0 0 1 2 0v9.2A3 3 0 0 1 12 20Z",
  drop: "M12 2s7 7.6 7 12.5A7 7 0 0 1 5 14.5C5 9.6 12 2 12 2Z",
  fan: "M12 11a3.5 3.5 0 0 0-1-7c-3 0-3.5 3-1 5l2 2Zm1 1a3.5 3.5 0 0 0 7 1c0-3-3-3.5-5-1l-2 0Zm-1 1a3.5 3.5 0 0 0 1 7c3 0 3.5-3 1-5l-2-2Zm-1-1a3.5 3.5 0 0 0-7-1c0 3 3 3.5 5 1l2 0Z",
  plug: "M9 2v5H7v5a5 5 0 0 0 4 4.9V22h2v-5.1A5 5 0 0 0 17 12V7h-2V2h-2v5h-2V2H9Z",
  chip: "M9 2v3H7a2 2 0 0 0-2 2v2H2v2h3v2H2v2h3v2a2 2 0 0 0 2 2h2v3h2v-3h2v3h2v-3h2a2 2 0 0 0 2-2v-2h3v-2h-3v-2h3V9h-3V7a2 2 0 0 0-2-2h-2V2h-2v3h-2V2H9ZM7 7h10v10H7V7Zm2 2v6h6V9H9Z",
  cube: "M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.7 8 12 11.7 5.3 8 12 4.3ZM5 9.7l6 3.4v6.6l-6-3.4V9.7Zm8 10v-6.6l6-3.4v6.6l-6 3.4Z",
  gauge: "M12 4a9 9 0 0 0-8 13.2l1.8-1A7 7 0 1 1 18.2 16l1.8 1A9 9 0 0 0 12 4Zm3.5 4.5-4.6 5.1a1.8 1.8 0 1 0 2.5 2.5l2.1-7.6Z",
  /* A soil probe: a body with prongs, as the probes stand in the substrate. */
  probe: "M8 2h8v9h-1.5v6L13 21v1h-2v-1l-1.5-4v-6H8V2Zm2 2v5h4V4h-4Z",
} as const;

export type IconName = keyof typeof PATHS;

export const icon = (name: IconName) => svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${PATHS[name]}></path></svg>`;
export const iconPath = (name: IconName) => PATHS[name];
