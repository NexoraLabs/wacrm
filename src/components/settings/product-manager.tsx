'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Loader2, X, Pencil, PackageX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { ProductSheetSection } from './product-sheet-section';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { Product } from '@/types';

interface ProductFormData {
  name: string;
  sku: string;
  description: string;
  price: string;
  currency: string;
  supplier_name: string;
  supplier_url: string;
  image_urls: string;
  is_available: boolean;
  ai_prompt: string;
  specifications: { key: string; value: string }[];
}

const emptyForm: ProductFormData = {
  name: '',
  sku: '',
  description: '',
  price: '0',
  currency: 'USD',
  supplier_name: '',
  supplier_url: '',
  image_urls: '',
  is_available: true,
  ai_prompt: '',
  specifications: [],
};

function specsToRows(specs: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(specs).map(([key, value]) => ({ key, value }));
}

function rowsToSpecs(rows: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    if (key.trim()) out[key.trim()] = value;
  }
  return out;
}

export function ProductManager() {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<ProductFormData>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);

  useEffect(() => {
    fetchProducts();
  }, []);

  async function fetchProducts() {
    try {
      setLoading(true);
      const res = await fetch('/api/products');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load products');
      setProducts(data.products || []);
    } catch (err) {
      console.error('Failed to fetch products:', err);
      toast.error('Failed to load products');
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(product: Product) {
    setEditingId(product.id);
    setForm({
      name: product.name,
      sku: product.sku ?? '',
      description: product.description ?? '',
      price: String(product.price),
      currency: product.currency,
      supplier_name: product.supplier_name ?? '',
      supplier_url: product.supplier_url ?? '',
      image_urls: product.image_urls.join('\n'),
      is_available: product.is_available,
      ai_prompt: product.ai_prompt ?? '',
      specifications: specsToRows(product.specifications),
    });
    setDialogOpen(true);
  }

  function buildPayload() {
    const price = Number.parseFloat(form.price);
    return {
      name: form.name.trim(),
      sku: form.sku.trim() || undefined,
      description: form.description.trim() || undefined,
      price: Number.isFinite(price) && price >= 0 ? price : 0,
      currency: form.currency.trim().toUpperCase() || 'USD',
      supplier_name: form.supplier_name.trim() || undefined,
      supplier_url: form.supplier_url.trim() || undefined,
      image_urls: form.image_urls
        .split('\n')
        .map((u) => u.trim())
        .filter(Boolean),
      is_available: form.is_available,
      ai_prompt: form.ai_prompt.trim() || undefined,
      specifications: rowsToSpecs(form.specifications),
    };
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    try {
      setSubmitting(true);
      const isEdit = editingId !== null;
      const res = await fetch(isEdit ? `/api/products/${editingId}` : '/api/products', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `${isEdit ? 'Update' : 'Create'} failed (HTTP ${res.status})`);
      }
      await fetchProducts();
      toast.success(isEdit ? 'Product updated' : 'Product created');
      setDialogOpen(false);
      setForm(emptyForm);
      setEditingId(null);
    } catch (err) {
      console.error('Product submit error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to save product');
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDelete() {
    const target = productToDelete;
    if (!target || deletingId) return;
    setDeletingId(target.id);
    try {
      const res = await fetch(`/api/products/${target.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Delete failed (HTTP ${res.status})`);
      toast.success('Product deleted');
      setProducts((prev) => prev.filter((p) => p.id !== target.id));
      setProductToDelete(null);
    } catch (err) {
      console.error('Product delete error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to delete product');
    } finally {
      setDeletingId(null);
    }
  }

  function addSpecRow() {
    setForm((prev) => ({
      ...prev,
      specifications: [...prev.specifications, { key: '', value: '' }],
    }));
  }

  function updateSpecRow(index: number, patch: Partial<{ key: string; value: string }>) {
    setForm((prev) => {
      const next = [...prev.specifications];
      next[index] = { ...next[index], ...patch };
      return { ...prev, specifications: next };
    });
  }

  function removeSpecRow(index: number) {
    setForm((prev) => ({
      ...prev,
      specifications: prev.specifications.filter((_, i) => i !== index),
    }));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title="Product catalog"
        description="Products your AI assistant can quote from — price, supplier, and specs feed straight into its replies. Not required for the CRM to work."
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            New Product
          </Button>
        }
      />

      {products.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <PackageX className="size-8 text-muted-foreground mb-2" />
            <p className="text-muted-foreground text-sm">No products yet.</p>
            <p className="text-muted-foreground text-xs mt-1">
              Add a product so the AI assistant can answer pricing and spec questions.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {products.map((product) => (
            <Card key={product.id}>
              <CardContent className="flex items-start justify-between pt-4">
                <div className="space-y-2 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-foreground">{product.name}</h3>
                    {product.sku && (
                      <span className="text-xs text-muted-foreground">SKU {product.sku}</span>
                    )}
                    <Badge
                      className={`text-xs border ${
                        product.is_available
                          ? 'bg-emerald-600/20 text-emerald-400 border-emerald-600/30'
                          : 'bg-muted text-muted-foreground border-border'
                      }`}
                    >
                      {product.is_available ? 'Available' : 'Unavailable'}
                    </Badge>
                  </div>
                  <p className="text-sm text-foreground">
                    {product.price.toLocaleString(undefined, {
                      style: 'currency',
                      currency: product.currency,
                    })}
                  </p>
                  {product.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {product.description}
                    </p>
                  )}
                  {Object.keys(product.specifications).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(product.specifications).map(([key, value]) => (
                        <span
                          key={key}
                          className="text-[11px] rounded border border-border bg-muted/50 px-1.5 py-0.5 text-muted-foreground"
                        >
                          {key}: {value}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(product)}
                    aria-label="Edit product"
                    className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 px-2"
                  >
                    <Pencil className="size-3.5" />
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setProductToDelete(product)}
                    disabled={deletingId === product.id}
                    aria-label="Delete product"
                    title="Delete this product"
                    className="text-muted-foreground hover:text-red-400 hover:bg-red-950/30 h-8 w-8"
                  >
                    {deletingId === product.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditingId(null);
            setForm(emptyForm);
          }
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editingId ? 'Edit Product' : 'New Product'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Details here are used both for your own reference and as grounding for
              the AI assistant&apos;s replies.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Name</Label>
                <Input
                  placeholder="e.g. Wireless Earbuds Pro"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">SKU (optional)</Label>
                <Input
                  placeholder="e.g. WEP-001"
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Description</Label>
              <Textarea
                placeholder="What this product is, who it's for..."
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Price</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  className="bg-muted border-border text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Currency</Label>
                <Input
                  placeholder="USD"
                  maxLength={3}
                  value={form.currency}
                  onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground uppercase"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Supplier name (optional)</Label>
                <Input
                  value={form.supplier_name}
                  onChange={(e) => setForm({ ...form, supplier_name: e.target.value })}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Supplier URL (optional)</Label>
                <Input
                  placeholder="https://…"
                  value={form.supplier_url}
                  onChange={(e) => setForm({ ...form, supplier_url: e.target.value })}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">Image URLs (optional, one per line)</Label>
              <Textarea
                placeholder={'https://…/photo-1.jpg\nhttps://…/photo-2.jpg'}
                value={form.image_urls}
                onChange={(e) => setForm({ ...form, image_urls: e.target.value })}
                rows={2}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground resize-none"
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">Available</p>
                <p className="text-xs text-muted-foreground">
                  Turn off to keep the product listed without offering it right now.
                </p>
              </div>
              <Switch
                checked={form.is_available}
                onCheckedChange={(checked) => setForm({ ...form, is_available: checked })}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-muted-foreground">Specifications (optional)</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addSpecRow}
                  className="border-border bg-transparent text-muted-foreground hover:bg-muted h-7 text-xs"
                >
                  <Plus className="size-3" />
                  Add spec
                </Button>
              </div>
              {form.specifications.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  Structured facts (color, material, warranty, shipping time...) the
                  assistant can quote exactly instead of guessing.
                </p>
              ) : (
                <div className="space-y-2">
                  {form.specifications.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        placeholder="Attribute (e.g. Warranty)"
                        value={row.key}
                        onChange={(e) => updateSpecRow(i, { key: e.target.value })}
                        className="flex-1 bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                      />
                      <Input
                        placeholder="Value (e.g. 1 year)"
                        value={row.value}
                        onChange={(e) => updateSpecRow(i, { value: e.target.value })}
                        className="flex-1 bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeSpecRow(i)}
                        className="text-muted-foreground hover:text-red-400 hover:bg-red-950/30 size-7"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">AI instructions (optional)</Label>
              <Textarea
                placeholder="Extra guidance for how the assistant should talk about this product..."
                value={form.ai_prompt}
                onChange={(e) => setForm({ ...form, ai_prompt: e.target.value })}
                rows={2}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground resize-none"
              />
              <p className="text-[11px] text-muted-foreground">
                Layered on top of the account-wide system prompt in AI Agents →
                Setup, not a replacement for it.
              </p>
            </div>

            {editingId && <ProductSheetSection productId={editingId} />}
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {editingId ? 'Saving…' : 'Creating…'}
                </>
              ) : editingId ? (
                'Save changes'
              ) : (
                'Create product'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={productToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setProductToDelete(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">Delete product?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {productToDelete &&
                `"${productToDelete.name}" will be removed from your catalog and the AI
                assistant will no longer be able to reference it. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setProductToDelete(null)}
              disabled={deletingId !== null}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deletingId !== null}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deletingId !== null ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
