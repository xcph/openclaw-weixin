import { describe, expect, it } from "vitest";

import { sanitizeAssistantOutboundForChannel } from "./outbound-privacy.js";

describe("sanitizeAssistantOutboundForChannel", () => {
  it("no-ops when showThinking is enabled", () => {
    const raw = "Reasoning:\n_one_\n💭思考\nnoop";
    expect(sanitizeAssistantOutboundForChannel(raw, { showThinking: true })).toBe(raw);
  });

  it("strips thinking tags, reasoning blocks, and 💭 headings when showThinking off", () => {
    expect(
      sanitizeAssistantOutboundForChannel(
        [
          "<thinking>nope</thinking>",
          "Hello",
          "Reasoning:",
          "_a_",
          "_b_",
          "💭思考",
          "leak",
          "",
          "Tail",
        ].join("\n"),
        { showThinking: false },
      ),
    ).toBe(["Hello", "Tail"].join("\n"));
  });

  it("removes 💭 prefixed lines even without 思考 suffix", () => {
    expect(
      sanitizeAssistantOutboundForChannel(`line1\n💭 stray\nline2`, { showThinking: false }),
    ).toBe("line1\nline2");
  });
});
