import type { Metadata } from "next";
import { Mark } from "@/components/Mark";
import { SectionHeader } from "@/components/SectionHeader";
import { fetchLab, type ApiWatchlistItem } from "@/lib/api";
import { relativeTime, timeLeft, truncateAddress } from "@/lib/format";

export const metadata: Metadata = {
  title: "The Lab",
  description:
    "Things we've spotted on the test network that haven't shipped for real yet.",
};

function watchId(item: ApiWatchlistItem): string {
  return item.programId ?? item.authority ?? item.id;
}

function signalLabel(item: ApiWatchlistItem): string {
  return item.kind === "fingerprint" ? "SAME CODE" : "SAME BUILDER";
}

function statusLabel(item: ApiWatchlistItem): string {
  switch (item.status) {
    case "active":
      return "WATCHING";
    case "matched":
      return "WENT LIVE";
    case "expired":
      return "EXPIRED";
  }
}

export default async function LabPage() {
  const items = await fetchLab();

  return (
    <>
      <SectionHeader
        title="In the lab"
        info="Everything on this page is our read, not the record — activity on the test network that hasn't shipped for real yet."
      />

      {/* The whole page lives in the inference register, and says so. */}
      <aside className="lab-banner">
        <p className="our-read-label">
          OUR READ
          <span className="conf-chip">THE WHOLE PAGE</span>
        </p>
        <p className="our-read-text">
          Nothing here is on the record. These are things we&apos;ve spotted
          being built and rehearsed on the test network — interesting enough
          to watch, but not real until they ship. When one goes live, it
          graduates to the feed as a story.
        </p>
      </aside>

      {items.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 18 }}>
          <Mark size={22} />
          <p className="empty-title">The lab is quiet</p>
          <p className="empty-body">
            When something worth watching shows up on the test network, it
            lands here.
          </p>
        </div>
      ) : (
        <div className="table-scroll" style={{ marginTop: 18 }}>
          <table className="record-table">
            <thead>
              <tr>
                <th scope="col">Watching</th>
                <th scope="col">Signal</th>
                <th scope="col">First seen</th>
                <th scope="col">Last seen</th>
                <th scope="col">Test runs</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const id = watchId(item);
                return (
                  <tr key={item.id}>
                    <td>
                      <a
                        className="receipt-link"
                        href={`https://orb.helius.dev/address/${id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={id}
                      >
                        {truncateAddress(id)}
                      </a>
                      {item.note ? (
                        <span className="lab-note">{item.note}</span>
                      ) : null}
                    </td>
                    <td className="cell-dim">{signalLabel(item)}</td>
                    <td className="cell-dim">{relativeTime(item.firstSeenAt)}</td>
                    <td>{relativeTime(item.lastSeenAt)}</td>
                    <td>{item.deployCount}</td>
                    <td className="cell-dim">
                      {item.status === "expired" ? "—" : timeLeft(item.expiresAt)}
                    </td>
                    <td>
                      <span className={`status-chip status-${item.status}`}>
                        {statusLabel(item)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
