import { Link } from "react-router-dom";
import { PublicHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-20">
        <h1 className="text-4xl font-bold">This page isn't here</h1>
        <p className="mt-3 text-ink-2">The link may be old. If you're looking for your subscription, use the link in your PayPal receipt or ask the shop.</p>
        <Button asChild className="mt-6">
          <Link to="/">Go to the home page</Link>
        </Button>
      </main>
    </>
  );
}
