import { useEffect, useState } from "react";
import { api } from "./api";
import type { Session } from "./types";

let cache: Promise<Session> | null = null;
export function getSession(fresh = false): Promise<Session> {
  if (!cache || fresh) cache = api.get<Session>("/ui/session").then((s) => {
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
