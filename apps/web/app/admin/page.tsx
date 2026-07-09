import { Mark } from "@/components/Mark";

export const metadata = { title: "Operator desk" };

/**
 * The story-era operator desk (dead-letter queue, story controls, announcement
 * feeding) was retired with the v2 pivot to the radar. Naming a program or a
 * clone cluster is still an operator lever, but that surface isn't built yet —
 * this is a deliberate stub, not a dead route.
 */
export default function AdminPage() {
  return (
    <div className="empty-state" style={{ marginTop: 40 }}>
      <Mark size={22} />
      <p className="empty-title">Operator desk</p>
      <p className="empty-body">
        The radar&apos;s operator controls (naming programs and clone clusters,
        rebanding) live in the backend for now. There is nothing to configure
        here yet.
      </p>
    </div>
  );
}
