export type SdmTool = "stock" | "flow" | "converter" | "source" | "sink" | "link";

/** Match the symbols on the stock-and-flow canvas rather than generic UI icons. */
export default function SystemDynamicsToolIcon({ tool }: { tool: SdmTool }) {
  return <svg aria-hidden="true" focusable="false" data-sfd-tool={tool} width="28" height="24" viewBox="0 0 32 28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {tool === "stock" && <rect x="4" y="5" width="24" height="18" rx="1" />}
    {tool === "converter" && <><circle cx="16" cy="14" r="10" /><path d="M13 19 L17 9 M12 12 H20" /></>}
    {tool === "flow" && <><path d="M2 13 H11 M21 13 H29 M2 16 H11 M21 16 H29 M25 10 L30 14.5 L25 19" /><path d="M11 10 L21 19 V10 L11 19 Z M16 10 V5 M12 5 H20" /></>}
    {tool === "source" && <g>
      <path d="M5 19 C-1 18 0 10 5 10 C5 4 14 4 15 10 C21 8 23 18 17 19 Z" />
      <path d="M20 13 H30 M20 16 H30 M27 10 L31 14.5 L27 19" />
    </g>}
    {tool === "sink" && <><path d="M17 19 C11 18 12 10 17 10 C17 4 26 4 27 10 C33 8 35 18 29 19 Z" /><path d="M1 13 H11 M1 16 H11 M8 10 L13 14.5 L8 19" /></>}
    {tool === "link" && <><circle cx="5" cy="20" r="2" /><path d="M7 19 C10 3 23 3 27 12 M21 10 L27 13 L29 7" /></>}
  </svg>;
}
