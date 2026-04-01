import { useEffect, useRef, useState, useCallback } from "react";

interface BannerCompositorProps {
  imageUrl: string;
  headline: string;
  subtitle?: string;
  bullets: string[];
  /** Canvas render size (default 1080) */
  size?: number;
  /** Called with the composited JPEG blob when ready */
  onComposite?: (blob: Blob) => void;
  className?: string;
}

const CANVAS_SIZE = 1080;
const PADDING = 60;
const TEXT_COVERAGE_LIMIT = 18;
const FONT_FAMILY = "'Inter', 'Roboto', system-ui, sans-serif";

interface TextBlock {
  x: number;
  y: number;
  w: number;
  h: number;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? current + " " + word : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function calculateCoverage(blocks: TextBlock[], w: number, h: number): number {
  const total = blocks.reduce((sum, b) => sum + b.w * b.h, 0);
  return (total / (w * h)) * 100;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTextLayers(
  ctx: CanvasRenderingContext2D,
  size: number,
  headline: string,
  subtitle: string | undefined,
  bullets: string[],
  fontScale: number
): { blocks: TextBlock[] } {
  const blocks: TextBlock[] = [];
  const headlineSize = Math.round(48 * fontScale);
  const subtitleSize = Math.round(28 * fontScale);
  const bulletSize = Math.round(26 * fontScale);
  const lineSpacing = Math.round(10 * fontScale);
  const maxWidth = size - PADDING * 2;

  // --- Gradient overlay: bottom 38%, transparent → black(60%) ---
  const gradTop = Math.round(size * 0.62);
  const grad = ctx.createLinearGradient(0, gradTop, 0, size);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradTop, size, size - gradTop);

  // --- Calculate headline layout for plaque ---
  ctx.font = "bold " + headlineSize + "px " + FONT_FAMILY;
  const headlineLines = wrapText(ctx, headline, maxWidth);
  const headlineLineHeight = Math.round(headlineSize * 1.2);
  const totalHeadlineH = headlineLines.length * headlineLineHeight;
  const maxHeadlineW = headlineLines.length > 0
    ? Math.max(...headlineLines.map((l) => ctx.measureText(l).width))
    : 0;

  // Start position: lower area
  const startY = Math.round(size * 0.62) + 20;
  let currentY = startY;

  // --- Headline plaque (semi-transparent background) ---
  if (headlineLines.length > 0 && maxHeadlineW > 0) {
    const plaquePadX = 12;
    const plaquePadY = 8;
    const plaqueX = PADDING - plaquePadX;
    const plaqueY = currentY - plaquePadY;
    const plaqueW = maxHeadlineW + plaquePadX * 2;
    const plaqueH = totalHeadlineH + plaquePadY * 2;

    ctx.fillStyle = "rgba(0,0,0,0.7)";
    roundRect(ctx, plaqueX, plaqueY, plaqueW, plaqueH, 6);
    ctx.fill();

    // Accent line (left edge, blue)
    ctx.fillStyle = "rgba(74,144,226,1)";
    ctx.fillRect(plaqueX, plaqueY + 4, 3, plaqueH - 8);
  }

  // --- Headline text ---
  ctx.font = "bold " + headlineSize + "px " + FONT_FAMILY;
  ctx.fillStyle = "#FFFFFF";
  ctx.textBaseline = "top";
  for (const line of headlineLines) {
    ctx.fillText(line, PADDING, currentY);
    const m = ctx.measureText(line);
    blocks.push({
      x: PADDING,
      y: currentY,
      w: m.width,
      h: headlineLineHeight,
    });
    currentY += headlineLineHeight;
  }
  currentY += lineSpacing;

  // --- Subtitle ---
  if (subtitle) {
    ctx.font = subtitleSize + "px " + FONT_FAMILY;
    ctx.fillStyle = "#DCDCDC";
    const subLines = wrapText(ctx, subtitle, maxWidth);
    const subLineH = Math.round(subtitleSize * 1.2);
    for (const line of subLines) {
      ctx.fillText(line, PADDING, currentY);
      const m = ctx.measureText(line);
      blocks.push({ x: PADDING, y: currentY, w: m.width, h: subLineH });
      currentY += subLineH;
    }
    currentY += lineSpacing;
  }

  // --- Bullets ---
  ctx.font = bulletSize + "px " + FONT_FAMILY;
  ctx.fillStyle = "#C8C8C8";
  const bulletLineH = Math.round(bulletSize * 1.2);
  for (const bullet of bullets) {
    if (!bullet) continue;
    const bText = "\u2022  " + bullet;
    const bLines = wrapText(ctx, bText, maxWidth);
    for (const line of bLines) {
      ctx.fillText(line, PADDING, currentY);
      const m = ctx.measureText(line);
      blocks.push({ x: PADDING, y: currentY, w: m.width, h: bulletLineH });
      currentY += bulletLineH;
    }
    currentY += Math.round(lineSpacing * 0.5);
  }

  return { blocks };
}

export default function BannerCompositor({
  imageUrl,
  headline,
  subtitle,
  bullets,
  size = CANVAS_SIZE,
  onComposite,
  className,
}: BannerCompositorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [coverageInfo, setCoverageInfo] = useState<{
    pct: number;
    passes: boolean;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onerror = () => {
      setLoadError(true);
    };
    img.onload = () => {
      setLoadError(false);
      canvas.width = size;
      canvas.height = size;

      // Auto-fit loop
      let fontScale = 1.0;
      let currentBullets = bullets.slice(0, 5);
      let currentSubtitle = subtitle;
      let currentHeadline = headline;

      for (let attempt = 0; attempt < 6; attempt++) {
        // Clear and redraw background
        ctx.drawImage(img, 0, 0, size, size);

        const result = drawTextLayers(
          ctx,
          size,
          currentHeadline,
          currentSubtitle,
          currentBullets,
          fontScale
        );

        const pct = calculateCoverage(result.blocks, size, size);
        if (pct <= TEXT_COVERAGE_LIMIT || attempt === 5) {
          setCoverageInfo({
            pct: Math.round(pct * 10) / 10,
            passes: pct <= TEXT_COVERAGE_LIMIT,
          });
          break;
        }

        // Auto-fit reductions
        if (attempt === 0) fontScale *= 0.9;
        else if (attempt === 1) fontScale *= 0.9;
        else if (attempt === 2 && currentBullets.length > 0)
          currentBullets = currentBullets.slice(0, -1);
        else if (attempt === 3 && currentSubtitle) currentSubtitle = undefined;
        else if (attempt === 4) {
          if (currentHeadline.length > 30)
            currentHeadline = currentHeadline.slice(0, 27) + "\u2026";
          fontScale *= 0.85;
        } else {
          fontScale *= 0.8;
        }
      }

      // Export blob
      if (onComposite) {
        canvas.toBlob(
          (blob) => {
            if (blob) onComposite(blob);
          },
          "image/jpeg",
          0.92
        );
      }
    };
    img.src = imageUrl;
  }, [imageUrl, headline, subtitle, bullets, size, onComposite]);

  useEffect(() => {
    render();
  }, [render]);

  return (
    <div className={className}>
      {loadError ? (
        <div className="aspect-square rounded-lg bg-muted flex items-center justify-center text-sm text-muted-foreground">
          Не удалось загрузить изображение
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          style={{
            width: "100%",
            maxWidth: size,
            height: "auto",
            borderRadius: 8,
          }}
        />
      )}
      {coverageInfo && !loadError && (
        <div
          className={
            "mt-1 text-xs " +
            (coverageInfo.passes
              ? "text-muted-foreground"
              : "text-destructive")
          }
        >
          Текст: {coverageInfo.pct}% / {TEXT_COVERAGE_LIMIT}% лимит
          {!coverageInfo.passes && " — превышен"}
        </div>
      )}
    </div>
  );
}
