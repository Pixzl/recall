import { homedir } from "node:os";
import { join } from "node:path";

export const RECALL_DIR = join(homedir(), ".recall");
export const DEFAULT_DB_PATH = join(RECALL_DIR, "index.db");
