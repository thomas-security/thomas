import { paths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./io.js";

export type Route = { provider: string; model: string };

type RouteStore = { routes: Record<string, Route> };

export async function readRoutes(): Promise<RouteStore> {
  return readJson<RouteStore>(paths.routes, { routes: {} });
}

export async function writeRoutes(store: RouteStore): Promise<void> {
  await writeJsonAtomic(paths.routes, store);
}

export async function setRoute(agentId: string, route: Route): Promise<void> {
  const store = await readRoutes();
  store.routes[agentId] = route;
  await writeRoutes(store);
}

export async function getRoute(agentId: string): Promise<Route | undefined> {
  const store = await readRoutes();
  return store.routes[agentId];
}

export function parseRouteSpec(spec: string): Route | undefined {
  const [provider, ...rest] = spec.split("/");
  if (!provider || rest.length === 0) return undefined;
  return { provider, model: rest.join("/") };
}
