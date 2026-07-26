import { describe, it, expect } from "vitest";
import { parseOrderExtractionResponse } from "./extract-order-fields";

describe("parseOrderExtractionResponse", () => {
  it("parses a well-formed JSON object", () => {
    const raw = JSON.stringify({
      name: "Ingrid Tatiana Contreras",
      phone: "3142048601",
      address: "Calle 7d # 78-62",
      city: "Bogotá",
      department: "Cundinamarca",
      neighborhood: null,
      quantity: "1",
    });
    expect(parseOrderExtractionResponse(raw)).toEqual({
      name: "Ingrid Tatiana Contreras",
      phone: "3142048601",
      address: "Calle 7d # 78-62",
      city: "Bogotá",
      department: "Cundinamarca",
      quantity: "1",
    });
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"name": "Ada Jasmin Erazo Burbano"}\n```';
    expect(parseOrderExtractionResponse(raw)).toEqual({
      name: "Ada Jasmin Erazo Burbano",
    });
  });

  it("drops unrecognized keys and non-string values", () => {
    const raw = JSON.stringify({ name: "Flor Vargas", total_price: 59900, extra: {} });
    expect(parseOrderExtractionResponse(raw)).toEqual({ name: "Flor Vargas" });
  });

  it("returns {} for invalid JSON", () => {
    expect(parseOrderExtractionResponse("not json at all")).toEqual({});
  });

  it("returns {} for a JSON array instead of an object", () => {
    expect(parseOrderExtractionResponse("[1, 2, 3]")).toEqual({});
  });
});
