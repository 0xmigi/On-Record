"use client";

import { useState, type ReactNode } from "react";

export interface DossierTab {
  id: string;
  label: string;
  panel: ReactNode;
}

/** Orb-style tabs under the program title. Panels are server-rendered and passed
 *  in; the client only toggles which one is visible (all stay mounted so state
 *  and scroll position survive tab switches). */
export function DossierTabs({ tabs }: { tabs: DossierTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  return (
    <div className="dtabs">
      <div className="dtabs-bar" role="tablist" aria-label="Program details">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            className={`dtab${active === t.id ? " active" : ""}`}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={active !== t.id}>
          {t.panel}
        </div>
      ))}
    </div>
  );
}
