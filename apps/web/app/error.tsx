"use client";

// App-level error boundary. The main way to land here is the backend being
// unreachable (lib/api.ts throws ApiUnavailableError) — say that plainly
// instead of letting an outage masquerade as an empty radar or a 404 dossier.

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="empty-state">
      <p className="empty-title">The record is unreachable</p>
      <p className="empty-body">
        The backend didn&apos;t answer. The chain keeps its own record — nothing is
        lost — but this page can&apos;t be drawn right now.
      </p>
      <p className="empty-body">
        <button type="button" onClick={() => reset()}>
          Try again
        </button>
      </p>
    </div>
  );
}
