"use client";

import { useEffect, useState } from "react";
import { type Snapshot } from "@/lib/burn";

export function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const es = new EventSource("/events");
    es.onopen = () => setLive(true);
    es.onmessage = (ev) => {
      setSnap(JSON.parse(ev.data));
      setLive(true);
    };
    es.onerror = () => setLive(false); // EventSource auto-reconnects
    return () => es.close();
  }, []);

  return { snap, live };
}
