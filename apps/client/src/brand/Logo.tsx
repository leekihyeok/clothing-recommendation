import { t } from '../i18n';

// ROUTE 01 logo (option B, chosen 2026-10-07): the O of ROUTE is an open loop — a walking route — with the one
// signal-orange dot where it starts. "01" sits small, same typeface. Colours and fonts follow design-system/MASTER.md.

/** The loop on its own: favicon, app icon, small places. Inherits the text colour for the ring. */
export function RouteLoop({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden>
      <circle
        cx="20"
        cy="20"
        r="15.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="5.5"
        strokeDasharray="86 12"
        transform="rotate(-128 20 20)"
      />
      <circle cx="8.4" cy="9.6" r="4.2" fill="var(--signal)" />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`} role="img" aria-label="ROUTE 01">
      R
      <RouteLoop className="wordmark-o" />
      UTE<sup>01</sup>
    </span>
  );
}

export function Logo() {
  return (
    <div className="logo">
      <Wordmark />
      <span className="logo-tagline">{t('취향대로 걷는 서울 옷가게 코스', "Seoul's clothing shops, walked your way")}</span>
    </div>
  );
}
