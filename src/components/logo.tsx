/** Het FreeBird-merkteken: een zwaluw in vlucht. Kleuren komen uit de CSS-variabelen, zodat het overal past. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <g transform="translate(32 32) scale(1.06) translate(-29.25 -29.75)">
        <path fill="var(--logo-bird, #0B6E8E)" d="M54 17.5 C51 15.8 46 15.6 43.2 18.6 C37.5 25.5 30.5 33.5 22 39.5 L4.5 44 L19.5 44.6 L9 54.5 C20 49.5 30.5 43.5 38.5 37.2 C43.5 33.2 47.2 28.2 49.6 22.6 Z" />
        <path fill="var(--logo-bird, #0B6E8E)" d="M41.5 23.8 C35 14.8 26.5 8.6 14.5 5 C21.5 12.8 26.5 21.6 32.4 32.6 Z" />
        <path fill="var(--logo-throat, #F07F2D)" d="M49.6 22.6 C48.6 25.2 47.2 27.4 45.6 29.4 C44.4 27.6 44.6 25 46 23.2 Z" />
        <circle cx="47.6" cy="20.2" r="1.25" fill="var(--logo-eye, #FFFFFF)" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Logo size={size} />
      <span>FreeBird</span>
    </span>
  );
}
