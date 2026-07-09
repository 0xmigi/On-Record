"use client";

import { useEffect, useState } from "react";
import { Liveline, type LivelinePoint } from "liveline";

/** Deploy + upgrade volume over time. The window is driven by the page toggle. */
export function FlowChart({
  volume,
  windowSecs,
}: {
  volume: { t: number; count: number }[];
  windowSecs: number;
}) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const data: LivelinePoint[] = volume.map((p) => ({ time: p.t, value: p.count }));
  const value = data.length ? data[data.length - 1]!.value : 0;

  const formatTime = (t: number) => {
    const d = new Date(t * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    if (windowSecs <= 86_400) return `${hh}:00`;
    if (windowSecs <= 172_800) return `${d.getMonth() + 1}/${d.getDate()} ${hh}:00`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <div className="flow-chart" style={{ height: 220 }}>
      {/* key remounts liveline on window change so it re-reads `window` */}
      <Liveline
        key={windowSecs}
        data={data}
        value={value}
        color="#E8432C"
        theme={dark ? "dark" : "light"}
        window={windowSecs}
        momentum={false}
        formatValue={(v) => String(Math.round(v))}
        formatTime={formatTime}
      />
    </div>
  );
}
