import { startLocal } from "../local/server.mjs";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be an integer from 1024 to 65535.");
const app = await startLocal({ port });
console.log(
  `Laras: ${app.url}\nOpen this address in your browser. ChatGPT OAuth is available in Settings.`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
