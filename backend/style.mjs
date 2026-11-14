import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export const MAX_CSS_BYTES = 64 * 1024;

export function createStyleStore(path) {
  let pending = Promise.resolve();

  async function read() {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  function save(css) {
    const result = pending.then(async () => {
      if (await read() === css) return false;
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, css, { encoding: "utf8", flag: "wx" });
        await rename(tmp, path);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      return true;
    });
    pending = result.catch(() => {});
    return result;
  }

  return { read, save };
}
