const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const IconSearch = () => <svg {...base}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
export const IconSun = () => <svg {...base}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
export const IconMoon = () => <svg {...base}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;
export const IconMenu = () => <svg {...base}><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
export const IconClose = () => <svg {...base}><path d="M6 6l12 12M18 6 6 18" /></svg>;
export const IconCopy = () => <svg {...base} width={15} height={15}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
export const IconCheck = () => <svg {...base} width={15} height={15}><path d="M5 12.5 10 17l9-10" /></svg>;
export const IconArrow = () => <svg {...base} width={16} height={16}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
export const IconInfo = () => <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
export const IconWarn = () => <svg {...base}><path d="M12 3 2 21h20L12 3z" /><path d="M12 10v4M12 17.5h.01" /></svg>;
export const IconShield = () => <svg {...base}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" /><path d="m9 12 2 2 4-4" /></svg>;

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--logo-bg)" />
      <path d="M9 8h6.5a4 4 0 0 1 0 8H9zm0 8h7.5a4 4 0 0 1 0 8H9z" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinejoin="round" />
    </svg>
  );
}
