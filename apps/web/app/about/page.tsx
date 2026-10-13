import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { Caveat } from "next/font/google";
import Link from "next/link";
import { AboutMotion } from "@/components/about/AboutMotion";
import { BitField } from "@/components/about/BitField";
import { Folds } from "@/components/about/Folds";
import { StatReel } from "@/components/about/StatReel";
import { Mark } from "@/components/Mark";

/**
 * The landing page. Its words are the Colosseum deck's and nothing is added,
 * but it is built as a page, not a slideshow, out of On Record's own pieces:
 * a live sheet of 0/1 cells where programs get found and ringed in red marker,
 * the site's ruled section headers, and the deck's hand-drawn diagrams, moving
 * (programs flow into the loader, the Flint timeline draws itself, the verify
 * loop turns). The sections are folded under
 * their ruled headers, one open at a time and taking turns (Folds), and the
 * problem's three numbers take turns inside theirs (StatReel).
 * Everything is live SVG/HTML, so it follows the theme, restacks on a phone,
 * and holds still for prefers-reduced-motion (see AboutMotion).
 */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "About",
  description: "On Record: Product Hunt for Solana. Every new Solana program, found when it deployed.",
  alternates: { canonical: "/about" },
};

// the deck's handwriting, for its scribbled notes
const caveat = Caveat({ subsets: ["latin"], weight: ["500", "700"], variable: "--font-caveat", display: "swap" });

/** CSS custom properties on an element, without fighting the style type. */
const vars = (v: Record<string, string | number>) => v as CSSProperties;

/** An open arrowhead at (x1,y1) for a stroke arriving from (x0,y0). */
function head(x0: number, y0: number, x1: number, y1: number, len = 16, deg = 35): string {
  const d = Math.hypot(x0 - x1, y0 - y1);
  const bx = (x0 - x1) / d;
  const by = (y0 - y1) / d;
  const a = (deg * Math.PI) / 180;
  const pt = (s: number) => {
    const c = Math.cos(a);
    const si = Math.sin(s * a);
    return `${(x1 + len * (bx * c - by * si)).toFixed(1)} ${(y1 + len * (bx * si + by * c)).toFixed(1)}`;
  };
  return `M ${pt(1)} L ${x1} ${y1} L ${pt(-1)}`;
}

/** The hand-drawn wobble, in three seeds so strokes can "boil" between them. */
function Wobble({ id, freq, scale, seed, w = 2000, h = 1200 }: { id: string; freq: number; scale: number; seed: number; w?: number; h?: number }) {
  return (
    <filter id={id} filterUnits="userSpaceOnUse" x="-40" y="-40" width={w} height={h}>
      <feTurbulence type="fractalNoise" baseFrequency={freq} numOctaves="3" seed={seed} result="n" />
      <feDisplacementMap in="SourceGraphic" in2="n" scale={scale} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
}

/* ----------------------------------------------------------------- solution */

const SOURCES = ["a startup", "a protocol upgrade", "a trading bot", "a solo devnet builder"];

const DOSSIER = [
  { name: "Composition", what: "what it's made of, look-alikes" },
  { name: "Trust", what: "who controls it, verified or not" },
  { name: "Interface", what: "what it can do" },
  { name: "Map", what: "dependencies and dependents" },
  { name: "Activity", what: "every upgrade, what changed" },
];

function Solution() {
  // four 48px pills, 14px apart: centres at 24 / 86 / 148 / 210, meeting at 117
  const ys = [24, 86, 148, 210];
  return (
    <div className="about-flow">
      <ul className="about-flow-sources">
        {SOURCES.map((s) => (
          <li className="about-rough quiet" key={s}>
            <span>{s}</span>
          </li>
        ))}
      </ul>

      <svg className="about-flow-join" viewBox="0 0 72 234" aria-hidden="true">
        <g className="about-line quiet" filter="url(#about-rough)">
          {ys.map((y) => (
            <path key={y} d={`M 0 ${y} L 46 117`} />
          ))}
          <path d="M 46 117 L 64 117" />
        </g>
        <path className="about-line quiet" d={head(46, 117, 68, 117, 10)} />
        {/* programs on their way to the loader */}
        {ys.map((y, i) => (
          <circle className="about-mote" r="4" key={y}>
            <animateMotion dur="2.8s" begin={`${i * 0.7}s`} repeatCount="indefinite" path={`M 0 ${y} L 46 117 L 70 117`} />
          </circle>
        ))}
      </svg>
      <span className="about-flow-down quiet" aria-hidden="true">
        ↓
      </span>

      <div className="about-flow-door">
        <span className="about-scribble quiet about-flow-door-note">deploys + upgrades</span>
        <div className="about-rough thin about-flow-door-outer">
          <div className="about-rough strong about-flow-door-inner">
            <span>BPF Upgradeable Loader</span>
          </div>
        </div>
      </div>

      <div className="about-flow-reads">
        <span className="about-scribble">reads the code</span>
        <svg viewBox="0 0 150 24" preserveAspectRatio="none" aria-hidden="true">
          <path className="about-line hot about-boil" filter="url(#about-rough)" d="M 2 12 L 138 12" />
        </svg>
        <svg className="about-flow-reads-head" viewBox="0 0 24 24" aria-hidden="true">
          <path className="about-line hot" d="M 6 3 L 20 12 L 6 21" />
        </svg>
        <i className="about-flow-reads-dot" aria-hidden="true" />
      </div>
      <span className="about-flow-down hot" aria-hidden="true">
        ↓
      </span>

      <div className="about-rough about-dossier">
        <div className="about-dossier-head">
          <span>On Record dossier</span>
          <span className="about-dossier-per">one per program</span>
        </div>
        <dl>
          {DOSSIER.map((d, i) => (
            <div className="about-dossier-row" key={d.name} style={vars({ "--i": i })}>
              <dt>{d.name}</dt>
              <span className="about-dossier-dots" aria-hidden="true" />
              <dd>{d.what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- validation */

const FLINT = [
  { x: 332, r: 10, date: "Aug 4", seen: ["spot"] },
  { x: 758, r: 12, date: "Aug 23", seen: ["lending, empty", "perps slot"] },
  { x: 960, r: 14, date: "Sep 1", seen: ["first perp market"] },
  { x: 1184, r: 15, date: "Sep 11", seen: ["perp orders, pnl"] },
  { x: 1430, r: 18, date: "Sep 22", seen: ["funding,", "liquidations"] },
];

function Flint() {
  return (
    <>
      <svg
        className="about-svg about-wide about-flint"
        viewBox="0 30 1664 450"
        role="img"
        aria-label="On Record: spot on Aug 4; lending and an empty perps slot on Aug 23; first perp market on Sep 1; perp orders and pnl on Sep 11; funding and liquidations on Sep 22. In public: nothing announced until Oct 1, perps announced. A month early."
      >
        <text className="about-t code row" x={0} y={109}>
          ON RECORD
        </text>
        <text className="about-t code row" x={0} y={359}>
          IN PUBLIC
        </text>

        <path className="about-line about-draw" pathLength={1} d="M 320 100 L 1650 100" />
        <g className="about-line quiet dashed about-fade" style={vars({ "--d": 16 })} filter="url(#about-rough)">
          <path d="M 320 350 L 1604 350" />
          <path d="M 960 200 L 960 336" />
        </g>

        {FLINT.map((f, i) => (
          <g className="about-pop" key={f.date} style={vars({ "--d": 2 + i * 3 })}>
            <text className="about-t code faint" x={f.x} y={64} textAnchor="middle">
              {f.date}
            </text>
            <circle className="about-dot" cx={f.x} cy={100} r={f.r} />
            {f.seen.map((line, n) => (
              <text className="about-t" x={f.x} y={160 + n * 30} textAnchor="middle" key={line}>
                {line}
              </text>
            ))}
          </g>
        ))}

        <text className="about-t code ghost about-fade" style={vars({ "--d": 18 })} x={612} y={324} textAnchor="middle">
          nothing announced
        </text>

        <g className="about-fade" style={vars({ "--d": 21 })}>
          <circle className="about-ping" cx={1632} cy={350} r={22} />
          <circle className="about-line hot thick about-boil" filter="url(#about-rough)" cx={1632} cy={350} r={22} />
          <circle className="about-dot hot" cx={1632} cy={350} r={9} />
          <text className="about-t scribble" x={1660} y={296} textAnchor="end" fontSize={48}>
            Oct 1: perps announced
          </text>
        </g>
        <path
          className="about-line hot thick about-draw"
          style={vars({ "--d": 24 })}
          pathLength={1}
          d="M 962 390 L 962 406 L 1632 406 L 1632 390"
        />
        <text className="about-t scribble about-fade" style={vars({ "--d": 29 })} x={1297} y={462} textAnchor="middle" fontSize={56}>
          a month early
        </text>
      </svg>

      <div className="about-narrow about-flint-m">
        <p className="about-rowlabel">On Record</p>
        <ol>
          {FLINT.map((f) => (
            <li key={f.date}>
              <span className="about-flint-m-date">{f.date}</span>
              <span>{f.seen.join(" ")}</span>
            </li>
          ))}
        </ol>
        <p className="about-rowlabel">In public</p>
        <p className="about-flint-m-quiet">nothing announced</p>
        <p className="about-scribble">Oct 1: perps announced</p>
        <p className="about-scribble big">a month early</p>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- go-to-market */

const LOOP = [
  { x: 270, y: 25, lines: ["team verifies its build"] },
  { x: 520, y: 265, lines: ["program gets upgraded"] },
  { x: 270, y: 505, lines: ["verification breaks", "silently"] },
  { x: 20, y: 265, lines: ["On Record sends the fix"] },
];
// once round the loop; it runs behind the boxes, so the marker ducks under each one
const LOOP_PATH =
  "M 630 70 Q 700 70 700 252 L 700 355 Q 700 550 642 550 L 270 550 Q 200 550 200 368 L 200 265 Q 200 70 258 70 Z";

function Loop() {
  return (
    <>
      <svg
        className="about-svg about-wide about-loop"
        viewBox="0 0 912 620"
        role="img"
        aria-label="A loop: team verifies its build, program gets upgraded, verification breaks silently, On Record sends the fix for free, verified again."
      >
        <g className="about-line hot thick">
          <g className="about-boil" filter="url(#about-rough)">
            <path d="M 630 70 Q 700 70 700 252" />
            <path d="M 700 355 Q 700 550 642 550" />
            <path d="M 270 550 Q 200 550 200 368" />
            <path d="M 200 265 Q 200 70 258 70" />
          </g>
          <path d="M 690.2 248 L 700 262 L 709.8 248" />
          <path d="M 646 540.2 L 632 550 L 646 559.8" />
          <path d="M 209.8 372 L 200 358 L 190.2 372" />
          <path d="M 254 79.8 L 268 70 L 254 60.2" />
        </g>
        <circle className="about-mote hot" r="11">
          <animateMotion dur="9s" repeatCount="indefinite" path={LOOP_PATH} />
        </circle>
        <g filter="url(#about-rough)">
          {LOOP.map((b, i) => (
            <rect className="about-box about-turn" style={vars({ "--i": i })} key={b.lines[0]} x={b.x} y={b.y} width={360} height={90} rx={12} />
          ))}
        </g>
        {LOOP.map((b) =>
          b.lines.map((line, i) => (
            <text
              className="about-t"
              key={line}
              x={b.x + 180}
              y={b.y + 45 + 10 + (i - (b.lines.length - 1) / 2) * 34}
              textAnchor="middle"
              fontSize={28}
            >
              {line}
            </text>
          )),
        )}
        <text className="about-t scribble" x={0} y={106} fontSize={40} transform="rotate(-6 0 106)">
          verified again
        </text>
        <text className="about-t scribble" x={68} y={472} fontSize={48} transform="rotate(-4 68 472)">
          free
        </text>
      </svg>

      <div className="about-narrow about-loop-m">
        <ol>
          <li className="about-rough">
            <span>team verifies its build</span>
          </li>
          <li className="about-rough">
            <span>program gets upgraded</span>
          </li>
          <li className="about-rough">
            <span>verification breaks silently</span>
          </li>
          <li className="about-rough">
            <span>On Record sends the fix</span>
            <em className="about-scribble">free</em>
          </li>
        </ol>
        <p className="about-scribble">↺ verified again</p>
      </div>
    </>
  );
}

/* --------------------------------------------------------------------- page */

function HeroNote() {
  return (
    <>
      <svg viewBox="0 0 240 110" aria-hidden="true">
        <path className="about-line hot thick about-boil" filter="url(#about-rough)" d="M 228 22 C 160 10, 80 24, 26 82" />
        <path className="about-line hot thick" d="M 21.5 68.5 L 22 88 L 40.2 80.8" />
      </svg>
      <span className="about-scribble">found, not submitted</span>
    </>
  );
}

export default function AboutPage() {
  return (
    <div className={`about ${caveat.variable}`}>
      <AboutMotion />
      <svg className="about-defs" width="0" height="0" aria-hidden="true">
        <defs>
          {/* diagram strokes (SVG user units) */}
          <Wobble id="about-rough" freq={0.018} scale={2.2} seed={7} />
          <Wobble id="about-rough-b" freq={0.018} scale={2.2} seed={19} />
          <Wobble id="about-rough-c" freq={0.018} scale={2.2} seed={31} />
          {/* HTML box outlines (CSS pixels) */}
          <Wobble id="about-rough-px" freq={0.03} scale={1.5} seed={4} w={1400} h={900} />
          <Wobble id="about-rough-px-b" freq={0.03} scale={1.5} seed={12} w={1400} h={900} />
          {/* the two strokes through "Product" */}
          <Wobble id="about-rough-strike" freq={0.021} scale={4} seed={11} w={700} h={160} />
        </defs>
      </svg>

      <header className="about-hero">
        <BitField />
        <div className="about-hero-in">
          <h1 className="about-title">
            <span className="about-title-line">
              Product Hunt
              <span className="about-hero-note" aria-hidden="true">
                <HeroNote />
              </span>
            </span>
            <br />
            <span className="about-dim">for Solana</span>
          </h1>
          <p className="about-hero-note-m">
            <HeroNote />
          </p>
          <p className="about-lede">Every new Solana program, found when it deployed.</p>
          <p className="about-cta">
            <Link href="/">
              Open the radar <span aria-hidden="true">→</span>
            </Link>
          </p>
        </div>
      </header>

      <section className="about-sec about-sec-folds" data-reveal>
        <div className="about-rise">
          <Folds
            items={[
              {
                id: "problem",
                label: "Problem",
                // long enough for its three numbers to each have their turn
                dur: 16,
                body: (
                  <>
                    <div className="about-head">
                      <h2 className="about-h">Solana needs more apps</h2>
                      <p className="about-sub">Trust is slow. The real signal is in the deploys themselves.</p>
                    </div>
                    <StatReel />
                    <p className="about-source">Of 21,770 live programs · 28 Sep 2026</p>
                  </>
                ),
              },
              {
                id: "solution",
                label: "Solution",
                body: (
                  <>
                    <div className="about-head">
                      <h2 className="about-h">
                        <span className="about-dim">Every new program</span> into a dossier
                      </h2>
                    </div>
                    <Solution />
                  </>
                ),
              },
              {
                id: "validation",
                label: "Validation",
                body: (
                  <>
                    <div className="about-head">
                      <h2 className="about-h">
                        Flint Trade, <span className="about-dim">seen before it was announced</span>
                      </h2>
                    </div>
                    <Flint />
                  </>
                ),
              },
              {
                id: "go-to-market",
                label: "Go-to-market",
                body: (
                  <div className="about-split">
                    <div>
                      <h2 className="about-h">
                        <span className="about-dim">Fixing the</span> verified program build process
                      </h2>
                      <p className="about-big">
                        <span className="about-dim">1 in</span> <span className="about-hot">4</span>
                      </p>
                      <p className="about-sub">verification attempts fail</p>
                      <p className="about-source">free alerts by Telegram or Discord / Slack webhook</p>
                    </div>
                    <div>
                      <Loop />
                    </div>
                  </div>
                ),
              },
            ]}
          />
        </div>
      </section>

      <footer className="about-close" data-reveal>
        <BitField seed={3} />
        <div className="about-close-in">
          <p className="about-source">~20 daily active users for the past month</p>
          <p className="about-title about-final">
            <span className="about-final-old">
              <span className="about-scribble about-final-new">Program</span>
              Product
              <svg viewBox="0 0 600 80" preserveAspectRatio="none" aria-hidden="true">
                <g className="about-line hot" filter="url(#about-rough-strike)">
                  <path className="about-draw" pathLength={1} d="M 14 46 C 160 34, 380 30, 586 38" />
                  <path className="about-draw" style={vars({ "--d": 3 })} pathLength={1} d="M 30 58 C 200 46, 400 44, 574 50" />
                </g>
              </svg>
            </span>{" "}
            Hunt for Solana
          </p>
          <p className="about-url">
            <Link href="/">
              <Mark size={26} />
              on-record.azuolas.xyz
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
