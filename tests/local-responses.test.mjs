import test from "node:test";
import assert from "node:assert/strict";
import { completedText } from "../local/responses.mjs";
const stream = (events) =>
  events.map((e) => "data: " + JSON.stringify(e) + "\r\n\r\n").join("");
test("Responses SSE handles UTF-8 and CRLF split across byte boundaries", async () => {
  const bytes = new TextEncoder().encode(
    stream([
      { type: "response.output_text.delta", delta: "Selesai ✓" },
      { type: "response.completed", response: { status: "completed" } },
    ]),
  );
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(index, index + 1));
      index++;
    },
  });
  assert.equal(await completedText(new Response(body)), "Selesai ✓");
});
test("interrupted, incomplete and failed streams cannot be reported as completed", async () => {
  for (const [event, code] of [
    [{ type: "response.incomplete" }, "CHATGPT_INCOMPLETE"],
    [
      {
        type: "response.failed",
        response: {
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      },
      "CHATGPT_USAGE_LIMIT",
    ],
  ])
    await assert.rejects(
      completedText(
        new Response(
          stream([
            { type: "response.output_text.delta", delta: "Partial" },
            event,
          ]),
        ),
      ),
      (e) => e.code === code,
    );
  await assert.rejects(
    completedText(
      new Response(
        stream([{ type: "response.output_text.delta", delta: "Partial" }]),
      ),
    ),
    (e) => e.code === "CHATGPT_INTERRUPTED",
  );
});
