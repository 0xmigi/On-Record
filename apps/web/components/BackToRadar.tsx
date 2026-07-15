"use client";

import { useRouter } from "next/navigation";

/** "← the radar" that actually returns you to where you were. If you arrived
 *  from within the app, it's a real history back (exact window/view/filters/
 *  scroll preserved); on direct entry (shared link, new tab) it falls back to
 *  the radar for the program's cluster. */
export function BackToRadar({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="back-link"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push(fallbackHref);
      }}
    >
      ← the radar
    </button>
  );
}
