/* The panel's icons, drawn inline because the frame can't fetch anything. Paths as the design mock has them. */
import { svg } from "lit";

const PATHS = {
  menu: "M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  sun: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 2.8l2.1 2.1-1.4 1.4-2.1-2.1zm15 15 2.1 2.1-1.4 1.4-2.1-2.1zM2.8 19.8l2.1-2.1 1.4 1.4-2.1 2.1zm15-15 2.1-2.1 1.4 1.4-2.1 2.1z",
  moon: "M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.4 5.4 0 0 1-7.54-7.54A9 9 0 0 0 12 3Z",
} as const;

export type IconName = keyof typeof PATHS;

export const icon = (name: IconName) => svg`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${PATHS[name]}></path></svg>`;
