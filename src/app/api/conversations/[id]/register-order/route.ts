// ============================================================
// POST /api/conversations/[id]/register-order
//
// Manual escape hatch for a real order that never went through the
// automated checkout flow — e.g. an agent (human or otherwise) closed
// the sale directly in the Inbox chat instead of the customer typing
// the flow's keyword trigger. Reuses the exact same `exportOrderRow`
// the flow engine's `export_order` node calls, so the sheet gets the
// same row shape either way — just synthesizes a one-off FlowRunRow
// instead of reading a real flow_runs row.
// ============================================================

import { NextResponse } from "next/server";

import {
  ForbiddenError,
  UnauthorizedError,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { exportOrderRow } from "@/lib/google-sheets/export-order";
import { extractOrderFieldsFromConversation } from "@/lib/google-sheets/extract-order-fields";
import type { ExportOrderNodeConfig, FlowRunRow } from "@/lib/flows/types";

type Params = { params: Promise<{ id: string }> };

/**
 * Prefill data for the "Registrar pedido" dialog — reads the contact
 * row AND runs an AI extraction over the whole conversation (see
 * extractOrderFieldsFromConversation), since customers routinely give
 * their real name/phone/address across several chat messages while a
 * human closes the sale, none of which lives on the contact record
 * itself. AI values win when present; contact fields are the fallback
 * (including when there's no AI configured at all).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id: conversationId } = await params;

    const { data: conversation, error: convError } = await ctx.supabase
      .from("conversations")
      .select("id, contact_id")
      .eq("id", conversationId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (convError || !conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const { data: contact } = await ctx.supabase
      .from("contacts")
      .select("name, phone, address, city, department, neighborhood")
      .eq("id", conversation.contact_id)
      .maybeSingle();

    const extracted = await extractOrderFieldsFromConversation(
      ctx.supabase,
      ctx.accountId,
      conversationId,
    );

    return NextResponse.json({
      name: extracted.name || contact?.name || "",
      phone: extracted.phone || contact?.phone || "",
      address: extracted.address || contact?.address || "",
      city: extracted.city || contact?.city || "",
      department: extracted.department || contact?.department || "",
      neighborhood: extracted.neighborhood || contact?.neighborhood || "",
      quantity: extracted.quantity || "1",
    });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    console.error("[GET /api/conversations/[id]/register-order]:", err);
    return NextResponse.json({ error: "Failed to load order prefill data" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id: conversationId } = await params;

    const limit = checkRateLimit(
      `registerOrder:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      productId?: unknown;
      quantity?: unknown;
      name?: unknown;
      phone?: unknown;
      address?: unknown;
      city?: unknown;
      department?: unknown;
      neighborhood?: unknown;
    } | null;

    const productId = typeof body?.productId === "string" ? body.productId : "";
    const address = typeof body?.address === "string" ? body.address.trim() : "";
    if (!productId || !address) {
      return NextResponse.json(
        { error: "productId and address are required" },
        { status: 400 },
      );
    }
    const quantity = typeof body?.quantity === "string" ? body.quantity.trim() : "1";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
    const city = typeof body?.city === "string" ? body.city.trim() : "";
    const department =
      typeof body?.department === "string" ? body.department.trim() : "";
    const neighborhood =
      typeof body?.neighborhood === "string" ? body.neighborhood.trim() : "";

    const { data: conversation, error: convError } = await ctx.supabase
      .from("conversations")
      .select("id, contact_id")
      .eq("id", conversationId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (convError || !conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    const { data: product, error: productError } = await ctx.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (productError || !product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const { data: sheetConfig } = await ctx.supabase
      .from("product_sheet_configs")
      .select("id")
      .eq("product_id", productId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!sheetConfig) {
      return NextResponse.json(
        {
          error:
            "Este producto no tiene una hoja de Google conectada (Ajustes → Productos).",
        },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const fakeRun: FlowRunRow = {
      id: crypto.randomUUID(),
      flow_id: "",
      account_id: ctx.accountId,
      user_id: ctx.userId,
      contact_id: conversation.contact_id,
      conversation_id: conversation.id,
      status: "completed",
      current_node_key: null,
      last_prompt_message_id: null,
      vars: {
        order_address: address,
        order_city: city,
        order_department: department,
        order_neighborhood: neighborhood,
        order_quantity: quantity,
      },
      reprompt_count: 0,
      started_at: now,
      last_advanced_at: now,
      ended_at: null,
      end_reason: null,
    };
    const cfg: ExportOrderNodeConfig = {
      product_id: productId,
      address_var_key: "order_address",
      city_var_key: "order_city",
      department_var_key: "order_department",
      neighborhood_var_key: "order_neighborhood",
      quantity_var_key: "order_quantity",
      next_node_key: "",
    };

    await exportOrderRow(ctx.supabase, fakeRun, cfg, { name, phone });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    if (err instanceof Error) {
      console.error("[POST /api/conversations/[id]/register-order]:", err.message);
      return NextResponse.json(
        { error: `No se pudo registrar el pedido: ${err.message}` },
        { status: 500 },
      );
    }
    return toErrorResponse(err);
  }
}
