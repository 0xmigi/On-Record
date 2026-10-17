"use client";

import { useState, type ReactNode } from "react";

type Net = "mainnet" | "devnet";

/** One cluster's record at a time. Mainnet is what people care about, so it
 *  is the default; devnet is a click away. Both tables are server-rendered and
 *  stay mounted. The switch is always there, so the page keeps its shape. */
export function ClusterSwitch({
  mainnet,
  devnet,
  initial,
}: {
  mainnet: ReactNode;
  devnet: ReactNode;
  initial: Net;
}) {
  const [net, setNet] = useState<Net>(initial);
  return (
    <div className="cswitch">
      <div className="cswitch-bar" role="tablist" aria-label="Cluster">
        {(["mainnet", "devnet"] as const).map((n) => (
          <button
            key={n}
            type="button"
            role="tab"
            aria-selected={net === n}
            className={`cswitch-btn cswitch-${n}${net === n ? " active" : ""}`}
            onClick={() => setNet(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <div hidden={net !== "mainnet"}>{mainnet}</div>
      <div className="record-devnet" hidden={net !== "devnet"}>
        {devnet}
      </div>
    </div>
  );
}
