import { useId } from "react";
import { day, sats, when } from "./format.ts";

/**
 * The jar as the app draws it from the jar's data, in the landing's crayon look (T45, stories 26-29).
 * It stands in for the contract's on-chain picture, which the app can't restyle.
 */
export function JarPicture(props: {
  nickname: string;
  balance: number;
  /** The allowance cap: the jar is drawn full at a few allowances of it. */
  cap?: number;
  unlockAt?: number;
  /** Null before the first top-up, when there is no next allowance to show. */
  nextAllowanceAt?: number | null;
  /** A demo-timing jar unlocks within minutes, so its unlock shows the time too. */
  demoTiming?: boolean;
  className?: string;
}) {
  const { nickname, balance, cap, unlockAt, nextAllowanceAt, demoTiming = false } = props;
  // useId's ids hold characters a url(#…) reference can't, so keep only the safe ones.
  const id = `jar${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const lines: { text: string; colour: string }[] = [];
  if (cap !== undefined) lines.push({ text: `Up to ${sats(cap)} an allowance`, colour: "var(--green)" });
  if (unlockAt !== undefined) lines.push({ text: `Unlocks ${demoTiming ? when(unlockAt) : day(unlockAt)}`, colour: "var(--blue)" });
  if (nextAllowanceAt != null) lines.push({ text: `Next allowance ${when(nextAllowanceAt)}`, colour: "var(--lilac)" });
  const height = lines.length === 0 ? 300 : 306 + lines.length * 22;
  const level = BOTTOM - fullness(balance, cap) * (BOTTOM - TOP);
  const shownNickname = nickname.length > NICKNAME_CHARS ? `${nickname.slice(0, NICKNAME_CHARS - 1)}…` : nickname;
  const shownBalance = sats(balance);
  return (
    <svg
      className={props.className}
      role="img"
      aria-label={`Picture of ${nickname}`}
      viewBox={`0 0 240 ${height}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <filter id={`${id}-crayon`} x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="4" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" />
        </filter>
        <clipPath id={`${id}-inside`}>
          <path d={JAR} />
        </clipPath>
        <pattern id={`${id}-hatch`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <line x1="0" y1="0" x2="0" y2="7" stroke="var(--ink)" strokeOpacity="0.13" strokeWidth="2.4" />
        </pattern>
      </defs>
      <rect width="240" height={height} fill="var(--paper)" />

      {/* The sats inside: an orange crayon fill with a wavy top and a few coins at the bottom. */}
      <g clipPath={`url(#${id}-inside)`}>
        {balance > 0 && (
          <g filter={`url(#${id}-crayon)`}>
            <path d={`M20 ${level} C60 ${level - 9} 92 ${level + 8} 130 ${level} S196 ${level - 7} 222 ${level} V300 H20 Z`} fill="var(--orange)" />
            <path d={`M20 ${level} C60 ${level - 9} 92 ${level + 8} 130 ${level} S196 ${level - 7} 222 ${level} V300 H20 Z`} fill={`url(#${id}-hatch)`} />
            {COINS.filter((coin) => coin.y - 9 > level).map((coin) => (
              <g key={`${coin.x}-${coin.y}`}>
                <circle cx={coin.x} cy={coin.y} r="11" fill="var(--yellow)" stroke="var(--ink)" strokeWidth="2.5" />
                <path d={`M${coin.x - 3} ${coin.y - 5} v10 M${coin.x + 1} ${coin.y - 5} v10`} stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" />
              </g>
            ))}
          </g>
        )}
      </g>

      {/* The jar and its lid, drawn twice with a wobble for the crayon look. */}
      <g filter={`url(#${id}-crayon)`} fill="none" stroke="var(--ink)" strokeLinecap="round" strokeLinejoin="round">
        <path d={JAR} strokeWidth="6.5" />
        <path d={JAR} strokeWidth="2" transform="translate(1.5 -1)" strokeOpacity="0.6" />
        <rect x="56" y="30" width="128" height="26" rx="8" fill="var(--yellow)" strokeWidth="5" />
        <path d="M76 36 v14 M96 36 v14 M116 36 v14 M136 36 v14 M156 36 v14" strokeWidth="2" strokeOpacity="0.5" />
        <path d="M188 112 C190 140 190 170 188 196" strokeWidth="3" stroke="var(--paper)" strokeOpacity="0.9" />
      </g>

      {/* Doodles, as on the landing. */}
      <g filter={`url(#${id}-crayon)`} strokeLinecap="round" strokeLinejoin="round">
        <path d="M212 14 l4 9 10 1 -7.5 6.5 2.5 10 -9 -5.5 -9 5.5 2.5 -10 -7.5 -6.5 10 -1 Z" fill="var(--pink)" stroke="var(--ink)" strokeWidth="2" />
        <path d="M24 30 v14 M17 37 h14 M19.5 32.5 l9 9 M28.5 32.5 l-9 9" stroke="var(--blue)" strokeWidth="2.6" />
      </g>

      {/* The label stuck on the jar: its nickname and balance. */}
      <g transform="rotate(-2.5 120 178)">
        <path
          d="M48 146 C80 141 160 142 192 146 C195 168 195 190 192 210 C160 214 80 215 48 210 C45 190 45 168 48 146 Z"
          fill="var(--paper)"
          stroke="var(--ink)"
          strokeWidth="3"
          filter={`url(#${id}-crayon)`}
        />
        <text
          x="120"
          y="174"
          textAnchor="middle"
          fill="var(--ink)"
          fontSize={fitted(shownNickname, 20, 0.6)}
          style={{ fontFamily: "var(--font-display)", fontWeight: 900, letterSpacing: "-0.02em" }}
        >
          {shownNickname}
        </text>
        <text
          x="120"
          y="198"
          textAnchor="middle"
          fill="var(--ink)"
          fontSize={fitted(shownBalance, 17, 0.56)}
          style={{ fontFamily: "var(--font-body)", fontWeight: 700 }}
        >
          {shownBalance}
        </text>
      </g>

      {lines.map((line, index) => (
        <g key={line.text} transform={`translate(0 ${318 + index * 22})`}>
          <ellipse cx="16" cy="-4" rx="5.5" ry="5" fill={line.colour} stroke="var(--ink)" strokeWidth="1.8" />
          <text x="28" y="0" fill="var(--muted)" fontSize="12.5" style={{ fontFamily: "var(--font-body)", fontWeight: 500 }}>
            {line.text}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** The jar's outline, after the landing's crayon jar: a short neck, round shoulders, a flat bottom. */
const JAR =
  "M66 56 C66 74 62 82 48 92 C36 100 30 110 30 126 L30 252 C30 274 42 286 64 286 L176 286 C198 286 210 274 210 252 L210 126 C210 110 204 100 192 92 C178 82 174 74 174 56";
/** The fill's surface rises from the bottom to the shoulders when full. */
const BOTTOM = 282;
const TOP = 96;
/** The jar is drawn full at this many allowances at the cap, or at a set amount when the cap isn't known. */
const ALLOWANCES_TO_FILL = 4;
const FULL_WITHOUT_CAP = 10_000;
/** Enough to show an amount, however small, above the bottom's curve. */
const LEAST_SHOWN = 0.06;
const NICKNAME_CHARS = 24;
const COINS = [
  { x: 62, y: 268 },
  { x: 92, y: 272 },
  { x: 122, y: 268 },
  { x: 152, y: 272 },
  { x: 180, y: 266 },
  { x: 76, y: 248 },
  { x: 166, y: 246 },
];

/** How full the jar is drawn, from 0 to 1. */
function fullness(balance: number, cap: number | undefined): number {
  if (balance <= 0) return 0;
  const full = cap !== undefined && cap > 0 ? cap * ALLOWANCES_TO_FILL : FULL_WITHOUT_CAP;
  return Math.min(1, Math.max(LEAST_SHOWN, balance / full));
}

/** A font size that keeps the text inside the label (about 136 units wide). */
function fitted(text: string, largest: number, widthPerSize: number): number {
  return Math.min(largest, 136 / (text.length * widthPerSize));
}
