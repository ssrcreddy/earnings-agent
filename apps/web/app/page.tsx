import { redirect } from "next/navigation";

// The week view (§22) arrives in Phase 5; until then the review queue is the landing screen.
export default function Home() {
  redirect("/review");
}
