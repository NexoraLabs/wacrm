import { describe, it, expect } from "vitest";
import {
  matchReplyId,
  matchTextReplyToMenu,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
  collectPendingInputFields,
  looksLikeMultiFieldReply,
  looksLikeAQuestion,
  looksWorthClassifying,
  buildFieldExtractionPrompt,
  parseFieldExtractionResponse,
  type PendingCollectInputField,
} from "./engine";
import type { FlowNodeRow } from "./types";

describe("matchReplyId", () => {
  it("returns null for nodes without options", () => {
    expect(
      matchReplyId({ node_type: "start", config: { next_node_key: "x" } }, "y"),
    ).toBeNull();
    expect(
      matchReplyId({ node_type: "send_message", config: {} }, "y"),
    ).toBeNull();
    expect(matchReplyId({ node_type: "end", config: {} }, "y")).toBeNull();
  });

  it("matches the buttons array on a send_buttons node", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick one",
        buttons: [
          { reply_id: "yes", title: "Yes", next_node_key: "confirmed" },
          { reply_id: "no", title: "No", next_node_key: "declined" },
        ],
      },
    };
    expect(matchReplyId(node, "yes")).toBe("confirmed");
    expect(matchReplyId(node, "no")).toBe("declined");
  });

  it("returns null when no button reply_id matches", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick",
        buttons: [
          { reply_id: "a", title: "A", next_node_key: "to_a" },
          { reply_id: "b", title: "B", next_node_key: "to_b" },
        ],
      },
    };
    expect(matchReplyId(node, "c")).toBeNull();
    expect(matchReplyId(node, "")).toBeNull();
  });

  it("searches across all sections in a send_list node", () => {
    const node = {
      node_type: "send_list",
      config: {
        text: "Pick an order",
        button_label: "View",
        sections: [
          {
            title: "Recent",
            rows: [
              { reply_id: "o1", title: "Order 1", next_node_key: "ord_1" },
            ],
          },
          {
            title: "Older",
            rows: [
              { reply_id: "o2", title: "Order 2", next_node_key: "ord_2" },
              { reply_id: "o3", title: "Order 3", next_node_key: "ord_3" },
            ],
          },
        ],
      },
    };
    expect(matchReplyId(node, "o1")).toBe("ord_1");
    expect(matchReplyId(node, "o2")).toBe("ord_2");
    expect(matchReplyId(node, "o3")).toBe("ord_3");
    expect(matchReplyId(node, "o99")).toBeNull();
  });

  it("returns null when send_list has no sections / empty sections", () => {
    expect(
      matchReplyId(
        { node_type: "send_list", config: { text: "x", sections: [] } },
        "x",
      ),
    ).toBeNull();
    expect(
      matchReplyId(
        {
          node_type: "send_list",
          config: { text: "x", sections: [{ rows: [] }] },
        },
        "x",
      ),
    ).toBeNull();
  });
});

describe("matchTextReplyToMenu", () => {
  const buttonsNode = {
    node_type: "send_buttons",
    config: {
      text: "Pick one",
      buttons: [
        { reply_id: "a", title: "Ver precio", next_node_key: "price_msg" },
        { reply_id: "b", title: "Cómo funciona", next_node_key: "audio_msg" },
        { reply_id: "c", title: "Otra pregunta", next_node_key: "collect_question" },
      ],
    },
  };

  it("matches by 1-indexed position", () => {
    expect(matchTextReplyToMenu(buttonsNode, "1")).toBe("price_msg");
    expect(matchTextReplyToMenu(buttonsNode, "2")).toBe("audio_msg");
    expect(matchTextReplyToMenu(buttonsNode, "3")).toBe("collect_question");
  });

  it("ignores out-of-range or non-numeric-looking positions, falling through to title match", () => {
    expect(matchTextReplyToMenu(buttonsNode, "0")).toBeNull();
    expect(matchTextReplyToMenu(buttonsNode, "4")).toBeNull();
  });

  it("matches by exact title, case/accent-insensitive", () => {
    expect(matchTextReplyToMenu(buttonsNode, "ver precio")).toBe("price_msg");
    expect(matchTextReplyToMenu(buttonsNode, "COMO FUNCIONA")).toBe("audio_msg");
  });

  it("matches by partial/substring title", () => {
    expect(matchTextReplyToMenu(buttonsNode, "precio")).toBe("price_msg");
  });

  it("returns null when nothing matches", () => {
    expect(matchTextReplyToMenu(buttonsNode, "banana")).toBeNull();
    expect(matchTextReplyToMenu(buttonsNode, "")).toBeNull();
    expect(matchTextReplyToMenu(buttonsNode, "   ")).toBeNull();
  });

  it("returns null for node types with no options", () => {
    expect(matchTextReplyToMenu({ node_type: "send_message", config: {} }, "1")).toBeNull();
  });

  it("searches across all sections in a send_list node, numbered continuously", () => {
    const listNode = {
      node_type: "send_list",
      config: {
        text: "Pick an order",
        button_label: "View",
        sections: [
          { title: "Recent", rows: [{ reply_id: "o1", title: "Order 1", next_node_key: "ord_1" }] },
          {
            title: "Older",
            rows: [
              { reply_id: "o2", title: "Order 2", next_node_key: "ord_2" },
              { reply_id: "o3", title: "Order 3", next_node_key: "ord_3" },
            ],
          },
        ],
      },
    };
    expect(matchTextReplyToMenu(listNode, "1")).toBe("ord_1");
    expect(matchTextReplyToMenu(listNode, "2")).toBe("ord_2");
    expect(matchTextReplyToMenu(listNode, "3")).toBe("ord_3");
    expect(matchTextReplyToMenu(listNode, "order 3")).toBe("ord_3");
  });
});

describe("matchesKeywordTrigger", () => {
  it("returns false for empty text", () => {
    expect(matchesKeywordTrigger("", { keywords: ["hi"] })).toBe(false);
  });

  it("returns false when keywords array is empty", () => {
    expect(matchesKeywordTrigger("anything", { keywords: [] })).toBe(false);
  });

  it("default match_type='contains' does case-insensitive substring", () => {
    const cfg = { keywords: ["support"] };
    expect(matchesKeywordTrigger("I need SUPPORT please", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Support is great", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Help me", cfg)).toBe(false);
  });

  it("match_type='exact' compares the whole string case-insensitively", () => {
    const cfg = { keywords: ["help"], match_type: "exact" as const };
    expect(matchesKeywordTrigger("help", cfg)).toBe(true);
    expect(matchesKeywordTrigger("HELP", cfg)).toBe(true);
    expect(matchesKeywordTrigger("help me", cfg)).toBe(false);
  });

  it("case_sensitive=true preserves case", () => {
    const cfg = {
      keywords: ["Support"],
      case_sensitive: true,
    };
    expect(matchesKeywordTrigger("I need Support", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need support", cfg)).toBe(false);
  });

  it("matches any one of multiple keywords", () => {
    const cfg = { keywords: ["help", "support", "issue"] };
    expect(matchesKeywordTrigger("I have an issue", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need Help!", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nothing to see here", cfg)).toBe(false);
  });

  it("skips empty strings in the keywords array", () => {
    const cfg = { keywords: ["", "support", ""] };
    expect(matchesKeywordTrigger("support center", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nope", cfg)).toBe(false);
  });
});

describe("node classification helpers", () => {
  it("isAutoAdvancing covers start + send_message + send_media + condition + set_tag + export_order", () => {
    expect(isAutoAdvancing("start")).toBe(true);
    expect(isAutoAdvancing("send_message")).toBe(true);
    expect(isAutoAdvancing("send_media")).toBe(true);
    expect(isAutoAdvancing("condition")).toBe(true);
    expect(isAutoAdvancing("set_tag")).toBe(true);
    expect(isAutoAdvancing("export_order")).toBe(true);
    expect(isAutoAdvancing("send_buttons")).toBe(false);
    expect(isAutoAdvancing("send_list")).toBe(false);
    expect(isAutoAdvancing("collect_input")).toBe(false);
    expect(isAutoAdvancing("handoff")).toBe(false);
    expect(isAutoAdvancing("end")).toBe(false);
  });

  it("isSuspending covers the input-requiring nodes", () => {
    expect(isSuspending("send_buttons")).toBe(true);
    expect(isSuspending("send_list")).toBe(true);
    expect(isSuspending("collect_input")).toBe(true);
    expect(isSuspending("start")).toBe(false);
    expect(isSuspending("send_message")).toBe(false);
    expect(isSuspending("condition")).toBe(false);
    expect(isSuspending("set_tag")).toBe(false);
    expect(isSuspending("export_order")).toBe(false);
    expect(isSuspending("handoff")).toBe(false);
    expect(isSuspending("end")).toBe(false);
  });

  it("isTerminal covers handoff + end", () => {
    expect(isTerminal("handoff")).toBe(true);
    expect(isTerminal("end")).toBe(true);
    expect(isTerminal("start")).toBe(false);
    expect(isTerminal("send_buttons")).toBe(false);
    expect(isTerminal("condition")).toBe(false);
  });

  it("the three classifications are mutually exclusive for known node types", () => {
    const types = [
      "start",
      "send_message",
      "send_buttons",
      "send_list",
      "send_media",
      "collect_input",
      "condition",
      "set_tag",
      "export_order",
      "handoff",
      "end",
    ];
    for (const t of types) {
      const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
      // Exactly one of the three should be true for every known node.
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe("evaluateConditionPredicate", () => {
  it("present: true when subject has a value", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "alice@example.com",
        configValue: undefined,
      }),
    ).toBe(true);
  });

  it("present: false when subject is undefined or empty", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(false);
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("absent: inverse of present", () => {
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: "x",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("equals: exact string comparison; case-sensitive", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "VIP",
        configValue: "VIP",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "vip",
        configValue: "VIP",
      }),
    ).toBe(false);
  });

  it("equals: undefined subject never matches (even against empty)", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: undefined,
        configValue: "",
      }),
    ).toBe(false);
  });

  it("contains: substring match", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@example.com",
        configValue: "@example.com",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@other.com",
        configValue: "@example.com",
      }),
    ).toBe(false);
  });

  it("contains: undefined subject never matches", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: undefined,
        configValue: "anything",
      }),
    ).toBe(false);
  });
});

describe("collectPendingInputFields", () => {
  function collectInputNode(
    key: string,
    varKey: string,
    nextKey: string,
  ): FlowNodeRow {
    return {
      id: key,
      flow_id: "flow-1",
      node_key: key,
      node_type: "collect_input",
      config: { prompt_text: `prompt for ${varKey}`, var_key: varKey, next_node_key: nextKey },
      position_x: 0,
      position_y: 0,
      created_at: "2026-01-01T00:00:00Z",
    };
  }

  const quantity = collectInputNode("q", "order_quantity", "addr");
  const address = collectInputNode("addr", "shipping_address", "city");
  const city = collectInputNode("city", "shipping_city", "export");
  const exportNode: FlowNodeRow = {
    id: "export",
    flow_id: "flow-1",
    node_key: "export",
    node_type: "export_order",
    config: {},
    position_x: 0,
    position_y: 0,
    created_at: "2026-01-01T00:00:00Z",
  };
  const nodes = new Map<string, FlowNodeRow>([
    ["q", quantity],
    ["addr", address],
    ["city", city],
    ["export", exportNode],
  ]);

  it("collects every unfilled collect_input node in the chain", () => {
    const fields = collectPendingInputFields(nodes, quantity, {});
    expect(fields.map((f) => f.var_key)).toEqual([
      "order_quantity",
      "shipping_address",
      "shipping_city",
    ]);
  });

  it("stops at the first non-collect_input node", () => {
    const fields = collectPendingInputFields(nodes, city, {});
    expect(fields.map((f) => f.var_key)).toEqual(["shipping_city"]);
  });

  it("stops at the first field that already has a value", () => {
    const fields = collectPendingInputFields(nodes, quantity, {
      shipping_address: "Calle 123",
    });
    expect(fields.map((f) => f.var_key)).toEqual(["order_quantity"]);
  });

  it("returns nothing when the starting field is already filled", () => {
    const fields = collectPendingInputFields(nodes, quantity, {
      order_quantity: "1",
    });
    expect(fields).toEqual([]);
  });
});

describe("looksLikeMultiFieldReply", () => {
  it("rejects short one-word answers", () => {
    expect(looksLikeMultiFieldReply("1")).toBe(false);
    expect(looksLikeMultiFieldReply("Bogotá")).toBe(false);
  });

  it("rejects long single-token strings with no separators", () => {
    expect(looksLikeMultiFieldReply("aaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("accepts a long comma-separated reply", () => {
    expect(
      looksLikeMultiFieldReply("1, Calle 123 #45-67, Bogotá, Cundinamarca, Chapinero"),
    ).toBe(true);
  });

  it("accepts a long reply with several words even without punctuation", () => {
    expect(
      looksLikeMultiFieldReply("quiero uno para la calle 123 en bogota chapinero"),
    ).toBe(true);
  });
});

describe("looksLikeAQuestion", () => {
  it("rejects plain field answers", () => {
    expect(looksLikeAQuestion("1")).toBe(false);
    expect(looksLikeAQuestion("Bogotá")).toBe(false);
    expect(looksLikeAQuestion("CRA 17 # 6-25")).toBe(false);
    expect(looksLikeAQuestion("La esmeralda")).toBe(false);
  });

  it("accepts anything with a question mark", () => {
    expect(looksLikeAQuestion("¿cuánto tarda el envío?")).toBe(true);
    expect(looksLikeAQuestion("es gratis el envio?")).toBe(true);
  });

  it("accepts common interrogative openers even without a question mark", () => {
    expect(looksLikeAQuestion("cuanto cuesta el envio")).toBe(true);
    expect(looksLikeAQuestion("como funciona la garantia")).toBe(true);
    expect(looksLikeAQuestion("donde queda la tienda")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(looksLikeAQuestion("   ")).toBe(false);
  });
});

describe("looksWorthClassifying", () => {
  it("rejects one- and two-word replies", () => {
    expect(looksWorthClassifying("1")).toBe(false);
    expect(looksWorthClassifying("La esmeralda")).toBe(false);
  });

  it("accepts replies with three or more words", () => {
    expect(looksWorthClassifying("Y el envío es gratis o lo cobran")).toBe(true);
    expect(looksWorthClassifying("cuanto cuesta el envio")).toBe(true);
  });
});

describe("buildFieldExtractionPrompt", () => {
  const fields: PendingCollectInputField[] = [
    { node_key: "q", var_key: "order_quantity", prompt_text: "¿Cuántas unidades?" },
    { node_key: "addr", var_key: "shipping_address", prompt_text: "¿Tu dirección?" },
  ];

  it("mentions every field's key and prompt text", () => {
    const prompt = buildFieldExtractionPrompt(fields);
    expect(prompt).toContain("order_quantity");
    expect(prompt).toContain("¿Cuántas unidades?");
    expect(prompt).toContain("shipping_address");
    expect(prompt).toContain("¿Tu dirección?");
    expect(prompt).toContain("JSON");
  });
});

describe("parseFieldExtractionResponse", () => {
  const fields: PendingCollectInputField[] = [
    { node_key: "q", var_key: "order_quantity", prompt_text: "qty" },
    { node_key: "addr", var_key: "shipping_address", prompt_text: "addr" },
  ];

  it("parses a clean JSON object", () => {
    const raw = '{"order_quantity": "1", "shipping_address": "Calle 123"}';
    expect(parseFieldExtractionResponse(raw, fields)).toEqual({
      order_quantity: "1",
      shipping_address: "Calle 123",
    });
  });

  it("strips a markdown code fence around the JSON", () => {
    const raw = '```json\n{"order_quantity": "2"}\n```';
    expect(parseFieldExtractionResponse(raw, fields)).toEqual({ order_quantity: "2" });
  });

  it("drops unknown keys, null values, and empty strings", () => {
    const raw = JSON.stringify({
      order_quantity: "1",
      shipping_address: null,
      some_unknown_field: "x",
      extra: "",
    });
    expect(parseFieldExtractionResponse(raw, fields)).toEqual({ order_quantity: "1" });
  });

  it("returns {} for invalid JSON", () => {
    expect(parseFieldExtractionResponse("not json at all", fields)).toEqual({});
  });

  it("returns {} for a JSON array instead of an object", () => {
    expect(parseFieldExtractionResponse('["1", "Calle 123"]', fields)).toEqual({});
  });
});
