interface BannerPreviewProps {
  title: string;
  text: string;
  imageStorageId?: string;
  isSelected?: boolean;
  vkBannerId?: string;
  onToggleSelected?: () => void;
  compact?: boolean;
}

export function BannerPreview({
  title,
  text,
  imageStorageId,
  isSelected,
  vkBannerId,
  onToggleSelected,
  compact = false,
}: BannerPreviewProps) {
  return (
    <div
      className={`p-4 rounded-lg border-2 transition-colors ${
        isSelected ? 'border-primary/50 bg-primary/5' : 'border-border'
      }`}
      data-testid="banner-preview"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-sm">{title}</h4>
          <p className="text-sm text-muted-foreground mt-1">{text}</p>
        </div>
        {onToggleSelected && (
          <label className="flex items-center gap-1 ml-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={onToggleSelected}
              className="w-4 h-4 rounded"
              data-testid="banner-select-checkbox"
            />
          </label>
        )}
      </div>

      {imageStorageId && (
        <img
          src={`${import.meta.env.VITE_CONVEX_SITE_URL || ''}/api/storage/${imageStorageId}`}
          alt="Баннер"
          className={`rounded-lg border border-border mt-2 ${compact ? 'w-full max-w-[120px]' : 'w-full max-w-[200px]'}`}
        />
      )}

      {vkBannerId && (
        <p className="text-xs text-muted-foreground mt-2">
          myTarget ID: {vkBannerId}
        </p>
      )}
    </div>
  );
}
