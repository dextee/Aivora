const icons = {
  menu: "M4 7h16M4 12h16M4 17h16",
  back: "m14 6-6 6 6 6",
  close: "m6 6 12 12M18 6 6 18",
  arrow: "M7 12h10m-4-4 4 4-4 4",
  mic: "M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V6Zm-3 5v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6",
  inbox: "M4 4h16l2 12v4H2v-4L4 4Zm-2 12h6l2 2h4l2-2h6",
  calendar: "M5 5h14a2 2 0 0 1 2 2v13H3V7a2 2 0 0 1 2-2Zm-2 5h18M8 3v4m8-4v4",
  shop: "M4 10 6 4h12l2 6M4 10a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0m-15 2v8h14v-8m-9 8v-4h4v4",
  studio: "M4 5h16v14H4V5Zm0 5h16M8 5l3 5m4-5 3 5m-7 3 3 2-3 2v-4Z",
  customers: "M15 20H3v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2ZM12.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM21 20v-2a4 4 0 0 0-3-4m-2-10a3.5 3.5 0 0 1 0 7",
  box: "m12 3 9 5v8l-9 5-9-5V8l9-5ZM3 8l9 5 9-5m-9 5v8M7 5.8l10 5.5",
  chart: "M4 4v16h16M8 16v-4m4 4V8m4 8v-6m4 6V6",
  doc: "M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8m-8 4h8",
  shield: "M12 22s7-3 7-9V5l-7-3-7 3v8c0 6 7 9 7 9Zm-3-10 2 2 4-4",
  key: "M14 10a4 4 0 1 1 4 4h-4l-5 5H5v-4l5-5h4Zm4 0h.01",
  info: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Zm-10-1v5m0-8h.01",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1.5 4.5L21 21",
  attach: "m8 12 6-6a3 3 0 0 1 4 4l-8 8a4 4 0 0 1-6-6l7-7m-3 11 7-7",
  send: "M12 19V5m-6 6 6-6 6 6",
  logout: "M10 4H4v16h6m4-4 4-4-4-4m-6 4h10",
  stop: "M7 7h10v10H7z",
} satisfies Record<string, string>;

export type WorkspaceIconName = keyof typeof icons;

export function WorkspaceIcon({ name, size = 20 }: { name: WorkspaceIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d={icons[name]} />
    </svg>
  );
}
