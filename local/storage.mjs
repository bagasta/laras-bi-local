import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { sealToken, openToken } from "../server/infrastructure/control.js";

export async function localKey(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(directory, "master.key");
  try {
    await writeFile(file, randomBytes(32).toString("base64"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const key = (await readFile(file, "utf8")).trim();
  if (Buffer.from(key, "base64").length !== 32)
    throw new Error(
      "Local encryption key is invalid. Restore the original master.key; do not replace it.",
    );
  await chmod(file, 0o600);
  return key;
}
export class SecureStore {
  constructor(directory, key) {
    this.file = path.join(directory, "chatgpt.enc");
    this.env = { LARAS_ENCRYPTION_KEY: key };
    this.queue = Promise.resolve();
  }
  async read() {
    try {
      return JSON.parse(
        await openToken(
          await readFile(this.file, "utf8"),
          "laras-chatgpt-profiles",
          this.env,
        ),
      );
    } catch (error) {
      if (error.code === "ENOENT")
        return {
          version: 1,
          hostId: "urn:uuid:" + randomUUID(),
          profiles: [],
          selected: null,
        };
      throw new Error(
        "Saved ChatGPT credentials could not be opened. Restore the original local key and credential file.",
      );
    }
  }
  async write(value) {
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        temp,
        await sealToken(
          JSON.stringify(value),
          "laras-chatgpt-profiles",
          this.env,
        ),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temp, this.file);
      await chmod(this.file, 0o600);
    } catch (error) {
      await import("node:fs/promises").then((fs) =>
        fs.unlink(temp).catch(() => {}),
      );
      throw error;
    }
  }
  run(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async initialize() {
    return this.run(async () => {
      const data = await this.read();
      await this.write(data);
      return data;
    });
  }
}
