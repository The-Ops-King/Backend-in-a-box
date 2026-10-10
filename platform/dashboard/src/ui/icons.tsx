/** The few icons the pages use, inline so nothing loads. One meaning each (design guide §2.4). */
const P = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const Check = () => <svg viewBox="0 0 20 20" {...P} strokeWidth={2.4}><path d="M4 10.5l4 4 8-9" /></svg>;
export const Clock = () => <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.5" /><path d="M10 6v4.5l3 2" /></svg>;
export const Warn = () => <svg viewBox="0 0 20 20" {...P}><path d="M10 3l8 14H2z" /><path d="M10 9v3.5M10 14.5v.5" /></svg>;
export const Skip = () => <svg viewBox="0 0 20 20" {...P}><circle cx="10" cy="10" r="7.5" /><path d="M7 10h6" /></svg>;
export const Cond = () => <svg viewBox="0 0 20 20" {...P}><path d="M6 4v12M6 8c0 3 8 1 8 5M14 13l-2-2M14 13l2-2" /></svg>;
export const Stop = () => <svg viewBox="0 0 20 20" {...P}><rect x="5" y="5" width="10" height="10" rx="2" /></svg>;
export const Back = () => <svg viewBox="0 0 20 20" {...P}><path d="M12 4l-6 6 6 6" /></svg>;
export const Chev = () => <svg viewBox="0 0 20 20" {...P} strokeWidth={2.2}><path d="M8 5l5 5-5 5" /></svg>;
export const Out = () => <svg viewBox="0 0 20 20" {...P}><path d="M11 3h6v6M17 3l-8 8M15 11v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>;
export const Ghost = () => <svg viewBox="0 0 20 20" {...P}><path d="M4 17V9a6 6 0 0 1 12 0v8l-2-1.5L12 17l-2-1.5L8 17l-2-1.5z" /><path d="M8 9.5h.01M12 9.5h.01" strokeWidth={2.4} /></svg>;
export const Dot = () => <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.5" fill="currentColor" /></svg>;
export const stateIcon = (s: string) => s === "ok" ? <Check /> : s === "ghost" ? <Ghost /> : s === "here" ? <Clock /> : s === "warn" ? <Warn /> : s === "skip" || s === "blocked" ? <Skip /> : s === "stop" ? <Stop /> : null;
