import Link from "next/link";
import { Mark } from "@/components/Mark";

export default function NotFound() {
  return (
    <div className="empty-state" style={{ marginTop: 40 }}>
      <Mark size={22} />
      <p className="empty-title">Not on the record</p>
      <p className="empty-body">
        Nothing has been filed at this address. If it ships, we&apos;ll cover
        it.
      </p>
      <Link className="older-link" href="/">
        ← Back to the feed
      </Link>
    </div>
  );
}
