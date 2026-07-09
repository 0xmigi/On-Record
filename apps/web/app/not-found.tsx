import Link from "next/link";
import { Mark } from "@/components/Mark";

export default function NotFound() {
  return (
    <div className="empty-state" style={{ marginTop: 40 }}>
      <Mark size={22} />
      <p className="empty-title">Not on the record</p>
      <p className="empty-body">
        No program is on record at this address. If it deploys through the
        loader, it lands on the radar.
      </p>
      <Link className="older-link" href="/">
        ← Back to the radar
      </Link>
    </div>
  );
}
