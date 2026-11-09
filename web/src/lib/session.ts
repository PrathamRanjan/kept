import { useEffect, useState } from "react";
import { api } from "./api";
import type { Session } from "./types";
import { setTourContext } from "@/tours";

let cache: Promise<Session> | null = null;
export function getSession(fresh = false): Promise<Session> {
  if (!cache || fresh) cache = api.get<Session>("/ui/session").then((s) => {
    setTourContext({ demoShop: s.demoShop, demoMemberRef: s.demoMemberRef });
    return s;
  });
  return cache;
}
export function useSession() {
  const [s, setS] = useState<Session | null>(null);
  useEffect(() => {
    getSession().then(setS, () => setS(null));
  }, []);
  return s;
}
