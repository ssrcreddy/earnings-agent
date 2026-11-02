import { redirect } from "next/navigation";

// The week view is the landing screen during earnings season (§22).
export default function Home() {
  redirect("/week");
}
