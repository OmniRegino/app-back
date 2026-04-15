// src/lib/ws-instance.ts
import type { setupMapWebSocket } from "./map-ws.js";

export type MapWsInstance = ReturnType<typeof setupMapWebSocket>;

export let mapWsInstance: MapWsInstance | null = null;

export function setMapWsInstance(instance: MapWsInstance) {
  mapWsInstance = instance;
}
