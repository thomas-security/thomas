import { paths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./io.js";

export type ThomasConfig = {
  port: number;
  host: string;
};

export const DEFAULT_CONFIG: ThomasConfig = {
  port: 51168,
  host: "127.0.0.1",
};

export async function readConfig(): Promise<ThomasConfig> {
  const stored = await readJson<Partial<ThomasConfig>>(paths.config, {});
  return { ...DEFAULT_CONFIG, ...stored };
}

export async function writeConfig(cfg: ThomasConfig): Promise<void> {
  await writeJsonAtomic(paths.config, cfg);
}
