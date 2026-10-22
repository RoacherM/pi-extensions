// Test-only: a scripted model for the real pi CLI. Tool calls come from
// PI_LFS_SCRIPT (JSON array of turns; each turn is [[toolName, args], ...]).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  const turns: Array<Array<[string, unknown]>> = JSON.parse(process.env.PI_LFS_SCRIPT ?? "[]");
  const core = createFauxCore({ provider: "lfs-faux", models: [{ id: "m" }] });
  core.setResponses(Array.from({ length: 50 }, () => () => {
    const calls = turns.shift();
    if (!calls || !calls.length) return fauxAssistantMessage(fauxText("SCRIPT_DONE"));
    return fauxAssistantMessage(calls.map(([n, a]) => fauxToolCall(n, a as any)), { stopReason: "toolUse" });
  }));
  pi.registerProvider("lfs-faux", {
    baseUrl: "http://localhost:0", apiKey: "faux", api: core.api, streamSimple: core.streamSimple,
    models: core.models.map((m) => ({ id: m.id, name: m.name, reasoning: false, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
  });
}
