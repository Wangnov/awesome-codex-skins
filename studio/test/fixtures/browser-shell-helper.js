(() => {
  "use strict";

  const imageCache = new Map();

  const extractUrl = (backgroundImage) => {
    const match = String(backgroundImage || "").match(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/);
    return (match?.[1] || match?.[2] || match?.[3] || "").trim();
  };

  const imageInfo = async (backgroundImage) => {
    const src = extractUrl(backgroundImage);
    if (!src) return { present: false, decoded: false, mime: null, bytes: 0, width: 0, height: 0 };
    if (!imageCache.has(src)) {
      imageCache.set(src, new Promise((resolve) => {
        const image = new Image();
        const done = (decoded) => resolve({
          present: true,
          decoded,
          mime: src.match(/^data:([^;,]+)/)?.[1] || "url",
          bytes: src.length,
          width: image.naturalWidth || 0,
          height: image.naturalHeight || 0,
        });
        image.onload = () => done(true);
        image.onerror = () => done(false);
        image.src = src;
        image.decode?.().then(() => done(true), () => {});
      }));
    }
    return imageCache.get(src);
  };

  const number = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const round = (value) => Math.round(value * 10) / 10;
  const rectObject = (rect) => rect ? {
    x: round(rect.left),
    y: round(rect.top),
    width: round(rect.right - rect.left),
    height: round(rect.bottom - rect.top),
    left: round(rect.left),
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
  } : null;

  const backgroundPaintRect = (element, pseudo, image) => {
    if (!image?.decoded || !(image.width > 0 && image.height > 0)) return null;
    const host = element.getBoundingClientRect();
    const style = getComputedStyle(element, pseudo || null);
    let boxX = host.left;
    let boxY = host.top;
    let boxWidth = host.width;
    let boxHeight = host.height;

    if (pseudo) {
      const left = number(style.left);
      const right = number(style.right);
      const top = number(style.top);
      const bottom = number(style.bottom);
      boxWidth = number(style.width);
      boxHeight = number(style.height);
      if (boxWidth === null && left !== null && right !== null) boxWidth = host.width - left - right;
      if (boxHeight === null && top !== null && bottom !== null) boxHeight = host.height - top - bottom;
      if (!(boxWidth > 0 && boxHeight > 0)) return null;
      boxX = left !== null ? host.left + left : host.right - (right || 0) - boxWidth;
      boxY = top !== null ? host.top + top : host.bottom - (bottom || 0) - boxHeight;
    }

    const size = style.backgroundSize.split(",")[0].trim().split(/\s+/);
    let drawWidth;
    let drawHeight;
    if (size[0] === "contain" || size[0] === "cover") {
      const scale = (size[0] === "contain" ? Math.min : Math.max)(
        boxWidth / image.width,
        boxHeight / image.height,
      );
      drawWidth = image.width * scale;
      drawHeight = image.height * scale;
    } else {
      const resolveSize = (token, extent) => {
        if (!token || token === "auto") return null;
        if (token.endsWith("%")) return extent * Number.parseFloat(token) / 100;
        return number(token);
      };
      drawWidth = resolveSize(size[0], boxWidth);
      drawHeight = resolveSize(size[1] || size[0], boxHeight);
      if (drawWidth === null && drawHeight === null) {
        drawWidth = Math.min(boxWidth, image.width);
        drawHeight = drawWidth * image.height / image.width;
      } else if (drawWidth === null) drawWidth = drawHeight * image.width / image.height;
      else if (drawHeight === null) drawHeight = drawWidth * image.height / image.width;
    }

    // Background paint never escapes its own painting box even when `cover`
    // computes an image larger than that box.
    drawWidth = Math.min(boxWidth, drawWidth);
    drawHeight = Math.min(boxHeight, drawHeight);
    const resolvePosition = (token, free) => {
      const normalized = String(token || "50%").trim().toLowerCase();
      if (normalized === "left" || normalized === "top") return 0;
      if (normalized === "center") return free / 2;
      if (normalized === "right" || normalized === "bottom") return free;
      if (normalized.endsWith("%")) return free * Number.parseFloat(normalized) / 100;
      return number(normalized) || 0;
    };
    const drawX = boxX + resolvePosition(style.backgroundPositionX, boxWidth - drawWidth);
    const drawY = boxY + resolvePosition(style.backgroundPositionY, boxHeight - drawHeight);

    if (!pseudo) {
      return {
        left: drawX,
        top: drawY,
        right: drawX + drawWidth,
        bottom: drawY + drawHeight,
      };
    }

    const origin = style.transformOrigin.split(/\s+/).map(number);
    const ox = origin[0] ?? boxWidth / 2;
    const oy = origin[1] ?? boxHeight / 2;
    let matrix;
    try { matrix = style.transform === "none" ? new DOMMatrix() : new DOMMatrix(style.transform); }
    catch { matrix = new DOMMatrix(); }
    const points = [
      [drawX, drawY],
      [drawX + drawWidth, drawY],
      [drawX + drawWidth, drawY + drawHeight],
      [drawX, drawY + drawHeight],
    ].map(([x, y]) => {
      const transformed = matrix.transformPoint(new DOMPoint(x - boxX - ox, y - boxY - oy));
      return { x: boxX + ox + transformed.x, y: boxY + oy + transformed.y };
    });
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    };
  };

  const clipRect = (subject, clip, clipX, clipY) => {
    if (!subject) return null;
    const clipped = {
      left: clipX ? Math.max(subject.left, clip.left) : subject.left,
      right: clipX ? Math.min(subject.right, clip.right) : subject.right,
      top: clipY ? Math.max(subject.top, clip.top) : subject.top,
      bottom: clipY ? Math.min(subject.bottom, clip.bottom) : subject.bottom,
    };
    return clipped.right - clipped.left > .1 && clipped.bottom - clipped.top > .1 ? clipped : null;
  };

  const visiblePaintRect = (element, sourceRect) => {
    let visible = sourceRect;
    const clips = [];
    for (let current = element; current && visible; current = current.parentElement) {
      const style = getComputedStyle(current);
      const clipX = ["auto", "clip", "hidden", "scroll"].includes(style.overflowX);
      const clipY = ["auto", "clip", "hidden", "scroll"].includes(style.overflowY);
      if (!clipX && !clipY) continue;
      const rect = current.getBoundingClientRect();
      clips.push({
        element: current.id || current.classList[0] || current.tagName.toLowerCase(),
        x: clipX,
        y: clipY,
        rect: rectObject(rect),
      });
      visible = clipRect(visible, rect, clipX, clipY);
    }
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    visible = clipRect(visible, viewport, true, true);
    return { rect: visible, clips };
  };

  const intersection = (left, right) => {
    if (!left || !right) return { width: 0, height: 0, area: 0 };
    const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
    const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    return { width, height, area: width * height };
  };

  const visibleElement = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > .5 && rect.height > .5 && style.display !== "none" &&
      style.visibility !== "hidden" && Number.parseFloat(style.opacity) > .05;
  };

  const measureLogo = async ({ mode, width, variant, state }) => {
    const logo = document.querySelector(".qa-workspace-switcher");
    const directStyle = getComputedStyle(logo);
    const pseudoStyle = getComputedStyle(logo, "::before");
    const directImage = await imageInfo(directStyle.backgroundImage);
    const pseudoImage = await imageInfo(pseudoStyle.backgroundImage);
    const source = pseudoImage.present ? "before" : directImage.present ? "element" : "none";
    const image = source === "before" ? pseudoImage : directImage;
    const sourceRect = backgroundPaintRect(logo, source === "before" ? "::before" : null, image);
    const visiblePaint = visiblePaintRect(logo, sourceRect);
    const visibleRect = visiblePaint.rect;
    const visibleArea = visibleRect ?
      Math.max(0, visibleRect.right - visibleRect.left) * Math.max(0, visibleRect.bottom - visibleRect.top) : 0;
    const logoRect = logo.getBoundingClientRect();
    const rowRect = document.querySelector(".qa-workspace-row").getBoundingClientRect();
    const sidebarRect = document.querySelector(".app-shell-left-panel").getBoundingClientRect();
    const chevron = logo.querySelector(".qa-button-inner > svg");
    const targets = [
      { name: "chevron", node: chevron },
      ...[...document.querySelectorAll(".qa-sidebar-actions button")].map((node) => ({
        name: node.getAttribute("aria-label")?.toLowerCase() || "sidebar-action",
        node,
      })),
    ].map(({ name, node }) => {
      const rect = node?.getBoundingClientRect() || null;
      const overlap = intersection(visibleRect, rect);
      return {
        name,
        visible: visibleElement(node),
        rect: rectObject(rect),
        overlap: { width: round(overlap.width), height: round(overlap.height), area: round(overlap.area) },
      };
    });
    const externalTargets = targets.filter((target) => target.name !== "chevron");
    const rowContained = logoRect.left >= rowRect.left - 1 && logoRect.right <= rowRect.right + 1 &&
      externalTargets.every((target) => target.rect && target.rect.left >= sidebarRect.left - 1 &&
        target.rect.right <= sidebarRect.right + 1);
    const stateReached = state === "hover" ? logo.matches(":hover") :
      state === "focus" ? document.activeElement === logo && logo.matches(":focus-visible") :
        !logo.matches(":hover") && document.activeElement !== logo;
    const semanticMatch = logo.dataset.ctsLogo === variant;
    const opacity = source === "before" ? Number.parseFloat(pseudoStyle.opacity) : Number.parseFloat(directStyle.opacity);
    const noOverlap = targets.every((target) => target.overlap.area <= .5);
    const chevronVisible = targets.find((target) => target.name === "chevron")?.visible === true;
    const pass = semanticMatch && stateReached && image.decoded && opacity > .05 && visibleArea > .5 &&
      rowContained && chevronVisible && noOverlap;

    return {
      mode,
      width,
      variant,
      state,
      stateReached,
      semanticMatch,
      annotatedVariant: logo.dataset.ctsLogo || null,
      source,
      image,
      opacity: Number.isFinite(opacity) ? opacity : null,
      backgroundSize: source === "before" ? pseudoStyle.backgroundSize : directStyle.backgroundSize,
      backgroundPosition: source === "before" ? pseudoStyle.backgroundPosition : directStyle.backgroundPosition,
      transform: source === "before" ? pseudoStyle.transform : directStyle.transform,
      logo: rectObject(logoRect),
      artSource: rectObject(sourceRect),
      artVisible: rectObject(visibleRect),
      visibleArea: round(visibleArea),
      clips: visiblePaint.clips,
      targets,
      rowContained,
      chevronVisible,
      noOverlap,
      pass,
    };
  };

  window.__CTS_BROWSER_FIXTURE__.measureLogo = measureLogo;
})();
