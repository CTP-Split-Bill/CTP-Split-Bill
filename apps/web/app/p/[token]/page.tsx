import type { Metadata } from "next";
import { Suspense } from "react";
import { GuestContent } from "./GuestContent";
import GuestLoading from "./loading";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Split Bill",
  description: "Split Bill",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
  openGraph: { title: "Split Bill", description: "Split Bill" },
  twitter: { card: "summary", title: "Split Bill", description: "Split Bill" },
};

export default async function GuestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Suspense fallback={<GuestLoading />}><GuestContent token={token} /></Suspense>;
}
