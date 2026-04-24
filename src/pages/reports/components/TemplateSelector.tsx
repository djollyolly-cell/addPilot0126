import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id, Doc } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Save, Plus, Trash2 } from "lucide-react";

type Template = Doc<"reportTemplates">;

export function TemplateSelector({
  userId,
  currentFilters,
  currentGranularity,
  currentFields,
  onTemplateLoad,
}: {
  userId: Id<"users">;
  currentFilters: Template["filters"];
  currentGranularity: Template["granularity"];
  currentFields: string[];
  onTemplateLoad: (template: Template) => void;
}) {
  const templates = useQuery(api.reportTemplates.list, { userId });
  const create = useMutation(api.reportTemplates.create);
  const update = useMutation(api.reportTemplates.update);
  const remove = useMutation(api.reportTemplates.remove);

  const [selectedId, setSelectedId] = useState<Id<"reportTemplates"> | "">("");
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!selectedId) return;
    setError(null);
    try {
      const t = templates?.find((x) => x._id === selectedId);
      if (!t) return;
      await update({
        id: selectedId,
        userId,
        name: t.name,
        description: t.description,
        filters: currentFilters,
        granularity: currentGranularity,
        fields: currentFields,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка сохранения");
    }
  }

  async function handleCreate() {
    setError(null);
    try {
      const id = await create({
        userId, name: newName,
        filters: currentFilters,
        granularity: currentGranularity,
        fields: currentFields,
      });
      setSelectedId(id);
      setShowSaveModal(false);
      setNewName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    try {
      await remove({ id: selectedId, userId });
      setSelectedId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  function handleChange(id: string) {
    if (id === "") {
      setSelectedId("");
      return;
    }
    const t = templates?.find((x) => x._id === (id as Id<"reportTemplates">));
    if (t) {
      setSelectedId(t._id);
      onTemplateLoad(t);
    }
  }

  return (
    <div className="flex items-center gap-2" data-testid="template-selector">
      <select
        className="px-3 py-2 border border-border rounded-md bg-background text-sm"
        value={selectedId}
        onChange={(e) => handleChange(e.target.value)}
        data-testid="template-dropdown"
      >
        <option value="">Без шаблона</option>
        {templates?.map((t) => (
          <option key={t._id} value={t._id}>{t.name}</option>
        ))}
      </select>
      <Button
        variant="outline" size="icon"
        onClick={handleSave} disabled={!selectedId}
        aria-label="Сохранить"
        data-testid="save-template-btn"
      >
        <Save className="h-4 w-4" />
      </Button>
      <Button
        variant="outline" size="icon"
        onClick={() => setShowSaveModal(true)}
        disabled={templates && templates.length >= 10}
        aria-label="Новый шаблон"
        data-testid="new-template-btn"
      >
        <Plus className="h-4 w-4" />
      </Button>
      <Button
        variant="outline" size="icon"
        onClick={handleDelete} disabled={!selectedId}
        aria-label="Удалить"
        data-testid="delete-template-btn"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}

      {showSaveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background rounded-lg p-6 w-full max-w-md space-y-4">
            <h3 className="font-bold">Новый шаблон</h3>
            <div>
              <Label htmlFor="tpl-name">Имя шаблона</Label>
              <Input
                id="tpl-name" value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
                data-testid="new-template-name"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowSaveModal(false)}>
                Отмена
              </Button>
              <Button onClick={handleCreate} disabled={!newName.trim()}>
                Создать
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
