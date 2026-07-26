"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Contact } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, PackageCheck } from "lucide-react";

interface RegisterOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contact: Contact;
}

interface SheetProductOption {
  id: string;
  name: string;
}

/**
 * Manual escape hatch for an order closed directly in the Inbox chat
 * (an agent typed the shipping-info template and the customer replied
 * with their data) instead of via the keyword-triggered checkout flow.
 * That path never called the flow engine's `export_order` node, so
 * nothing reached the merchant's Google Sheet even though a real sale
 * happened. Posts to the same `exportOrderRow` helper the flow uses —
 * see /api/conversations/[id]/register-order.
 */
export function RegisterOrderDialog({
  open,
  onOpenChange,
  conversationId,
  contact,
}: RegisterOrderDialogProps) {
  const [products, setProducts] = useState<SheetProductOption[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [department, setDepartment] = useState("");
  const [neighborhood, setNeighborhood] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadingPrefill, setLoadingPrefill] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Fast baseline from the contact row so the form isn't empty while
    // the AI prefill call (below) is still in flight.
    setName(contact.name ?? "");
    setPhone(contact.phone ?? "");
    setAddress(contact.address ?? "");
    setCity(contact.city ?? "");
    setDepartment(contact.department ?? "");
    setNeighborhood(contact.neighborhood ?? "");
    setQuantity("1");

    let cancelled = false;
    (async () => {
      setLoadingProducts(true);
      const supabase = createClient();
      const { data, error } = await supabase
        .from("product_sheet_configs")
        .select("product_id, products(id, name)")
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error("Failed to load sheet-connected products:", error);
        setProducts([]);
      } else {
        const options = (data ?? [])
          .map((row) => {
            const p = row.products as unknown as { id: string; name: string } | null;
            return p ? { id: p.id, name: p.name } : null;
          })
          .filter((p): p is SheetProductOption => p !== null);
        setProducts(options);
        setProductId((prev) => prev || options[0]?.id || "");
      }
      setLoadingProducts(false);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact.id]);

  // Best-effort AI prefill: reads the whole conversation and pulls out
  // whatever shipping/order data the customer already gave in chat, so
  // the agent doesn't have to retype what's already on screen above.
  // Falls back to (and never clobbers past) the contact-row baseline
  // set in the effect above when this fails or an AI isn't configured.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoadingPrefill(true);
      try {
        const res = await fetch(`/api/conversations/${conversationId}/register-order`);
        if (cancelled || !res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (data.name) setName(data.name);
        if (data.phone) setPhone(data.phone);
        if (data.address) setAddress(data.address);
        if (data.city) setCity(data.city);
        if (data.department) setDepartment(data.department);
        if (data.neighborhood) setNeighborhood(data.neighborhood);
        if (data.quantity) setQuantity(data.quantity);
      } catch (err) {
        console.error("Failed to prefill order fields from conversation:", err);
      } finally {
        if (!cancelled) setLoadingPrefill(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, conversationId]);

  async function handleSubmit() {
    if (!productId || !address.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/register-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          quantity: quantity.trim() || "1",
          name: name.trim(),
          phone: phone.trim(),
          address: address.trim(),
          city: city.trim(),
          department: department.trim(),
          neighborhood: neighborhood.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "No se pudo registrar el pedido");
        return;
      }
      toast.success("Pedido registrado en la hoja de Google Sheets");
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to register order:", err);
      toast.error("No se pudo registrar el pedido");
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = !!productId && address.trim().length > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <PackageCheck className="h-4 w-4 text-primary" />
            Registrar pedido
            {loadingPrefill && (
              <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Autocompletando desde el chat...
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Para cuando la venta se cerró directamente en el chat, sin pasar
            por el flujo automático. Esto exporta el pedido a la hoja de
            Google conectada, igual que el checkout automático.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-popover-foreground">Nombre</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nombre completo del cliente"
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-popover-foreground">Celular</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Número de contacto"
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-popover-foreground">Producto</Label>
            {loadingProducts ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Cargando productos...
              </div>
            ) : products.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Ningún producto de esta cuenta tiene una hoja de Google
                conectada (Ajustes → Productos).
              </p>
            ) : (
              <Select
                value={productId}
                onValueChange={(v) => setProductId(v ?? "")}
              >
                <SelectTrigger className="bg-muted">
                  <SelectValue placeholder="Selecciona un producto" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-popover-foreground">Cantidad</Label>
            <Input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="1"
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-popover-foreground">Dirección *</Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Calle 42 # 8-10"
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-popover-foreground">Ciudad</Label>
              <Input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-popover-foreground">Departamento</Label>
              <Input
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-popover-foreground">Barrio</Label>
            <Input
              value={neighborhood}
              onChange={(e) => setNeighborhood(e.target.value)}
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-popover-foreground hover:bg-muted"
          >
            Cancelar
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Registrar pedido"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
