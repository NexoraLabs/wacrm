"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Contact, Deal, ContactNote, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  PackageCheck,
  X,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { format } from "date-fns";
import { RegisterOrderDialog } from "./register-order-dialog";

const TAG_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

interface ContactSidebarProps {
  contact: Contact | null;
  conversationId?: string | null;
}

export function ContactSidebar({ contact, conversationId }: ContactSidebarProps) {
  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [registerOrderOpen, setRegisterOrderOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[3]);
  const [tagBusy, setTagBusy] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, this contact's tags, and every account tag
    // (for the add-tag picker) in parallel
    const [dealsRes, notesRes, tagsRes, allTagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
      supabase.from("tags").select("*").order("name"),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
    if (allTagsRes.data) setAllTags(allTagsRes.data);
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const toggleTag = useCallback(
    async (tag: Tag) => {
      if (!contact || tagBusy) return;
      setTagBusy(true);
      const supabase = createClient();
      const existing = tags.find((t) => t.id === tag.id);

      if (existing) {
        const { error } = await supabase
          .from("contact_tags")
          .delete()
          .eq("id", existing.contact_tag_id);
        if (error) {
          toast.error("No se pudo quitar la etiqueta");
        } else {
          setTags((prev) => prev.filter((t) => t.id !== tag.id));
        }
      } else {
        const { data, error } = await supabase
          .from("contact_tags")
          .insert({ contact_id: contact.id, tag_id: tag.id })
          .select("id")
          .single();
        if (error) {
          toast.error("No se pudo agregar la etiqueta");
        } else {
          setTags((prev) => [...prev, { ...tag, contact_tag_id: data.id }]);
        }
      }
      setTagBusy(false);
    },
    [contact, tagBusy, tags]
  );

  const handleCreateTag = useCallback(async () => {
    if (!contact || !accountId || !newTagName.trim() || tagBusy) return;
    setTagBusy(true);
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data: tag, error } = await supabase
      .from("tags")
      .insert({
        user_id: user?.id,
        account_id: accountId,
        name: newTagName.trim(),
        color: newTagColor,
      })
      .select()
      .single();

    if (error || !tag) {
      toast.error("No se pudo crear la etiqueta");
      setTagBusy(false);
      return;
    }

    const { data: ct, error: ctError } = await supabase
      .from("contact_tags")
      .insert({ contact_id: contact.id, tag_id: tag.id })
      .select("id")
      .single();

    if (ctError) {
      toast.error("Etiqueta creada, pero no se pudo asignar al contacto");
    } else {
      setTags((prev) => [...prev, { ...tag, contact_tag_id: ct.id }]);
    }
    setAllTags((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
    setNewTagName("");
    setNewTagColor(TAG_COLORS[3]);
    setTagBusy(false);
  }, [contact, accountId, newTagName, newTagColor, tagBusy]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">Select a conversation</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {conversationId && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full border-primary/30 text-primary hover:bg-primary/10"
              onClick={() => setRegisterOrderOpen(true)}
            >
              <PackageCheck className="h-4 w-4" />
              Registrar pedido
            </Button>
          )}

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <TagIcon className="h-3 w-3" />
                Tags
              </div>
              <Popover>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label="Agregar o crear etiqueta"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  }
                />
                <PopoverContent align="end" className="w-64">
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {allTags.length === 0 ? (
                      <p className="px-1 py-1 text-xs text-muted-foreground">
                        No hay etiquetas todavía — crea la primera abajo.
                      </p>
                    ) : (
                      allTags.map((tag) => {
                        const selected = tags.some((t) => t.id === tag.id);
                        return (
                          <button
                            key={tag.id}
                            type="button"
                            disabled={tagBusy}
                            onClick={() => toggleTag(tag)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
                          >
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: tag.color }}
                            />
                            <span className="flex-1 truncate">{tag.name}</span>
                            {selected && (
                              <Check className="h-3 w-3 shrink-0 text-primary" />
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>

                  <div className="mt-1 border-t border-border pt-2.5">
                    <Input
                      placeholder="Nueva etiqueta..."
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreateTag();
                      }}
                      disabled={tagBusy}
                      maxLength={40}
                      className="h-8 text-xs"
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex gap-1">
                        {TAG_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setNewTagColor(color)}
                            aria-label={`Usar color ${color}`}
                            aria-pressed={newTagColor === color}
                            className={cn(
                              "size-4 rounded-full transition-transform hover:scale-110",
                              newTagColor === color &&
                                "outline outline-2 outline-offset-1 outline-primary"
                            )}
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                      <Button
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={handleCreateTag}
                        disabled={tagBusy || !newTagName.trim()}
                      >
                        {tagBusy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Plus className="h-3 w-3" />
                        )}
                        Crear
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No tags</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="group inline-flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => toggleTag(tag)}
                      aria-label={`Quitar ${tag.name}`}
                      className="rounded-full p-0.5 opacity-60 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              Active Deals
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No deals</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              Notes
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>

      {conversationId && (
        <RegisterOrderDialog
          open={registerOrderOpen}
          onOpenChange={setRegisterOrderOpen}
          conversationId={conversationId}
          contact={contact}
        />
      )}
    </div>
  );
}
