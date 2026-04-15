import type { mapWsInstance } from "./map-ws.js";

export type MapWsInstance = typeof mapWsInstance;

export let mapWs: MapWsInstance | null = null;

export function setMapWsInstance(instance: MapWsInstance) {
  mapWs = instance;
}
