"use client";
import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { ErrorState } from "../../components/ErrorState";

export default function GuestError({ reset }: { error?: Error & { digest?: string }; reset?: () => void }) {
  const router = useRouter();
  return <ErrorState title="Couldn't load this receipt" message="Check your connection and try again."
    onRetry={() => startTransition(() => { router.refresh(); reset?.(); })} />;
}
