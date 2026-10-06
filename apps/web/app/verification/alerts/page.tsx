import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AlertManage } from "@/components/AlertManage";

// The manage link in every verification alert. Private to whoever holds it.
export const metadata: Metadata = {
  title: "Verification alerts",
  robots: { index: false, follow: false },
};

export default function AlertsManagePage() {
  return (
    <article className="essay">
      <h1>Verification alerts</h1>
      <Suspense fallback={null}>
        <AlertManage />
      </Suspense>
      <p className="essay-meta essay-live">
        <Link href="/verification">Back to verification</Link>
      </p>
    </article>
  );
}
