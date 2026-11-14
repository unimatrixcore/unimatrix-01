import type { Bounds, Point } from "./geometry.mts";

export type Region = {
  id: string;
  category: string;
  label: string | null;
  seat: number | null;
  template: string | null;
  cardSlot: number | null;
  bounds: Bounds | null;
  polygon: Point[] | null;
  rotation: number;
  visibility: "visible" | "absent" | "unsupported";
  reason: string | null;
  labelEvidence: "controlled_render_state";
  visuallyVerified: false;
  semanticValue?: string | number | null;
  inkBounds?: Bounds | null;
  inkPolygon?: Point[] | null;
  cropBounds?: Bounds | null;
  cropLabel?: string | null;
  autoLabelEligible?: boolean;
  cropOverlaps?: string[];
  envelope?: { policy: string; limit: string; clippedToViewport: boolean };
};

type MockState = {
  seats: { cards: (string | null)[] }[];
  board: (string | null)[];
  theme: { cards: string };
  active?: number | null;
  dealer?: number | null;
  timer?: { remaining: number };
  currencyFormat?: string;
};

declare global {
  interface Window {
    poker: {
      ready(): Promise<void>;
      getState(): MockState;
      setState(state: unknown): void;
      replay: { pause(): void };
      effects: { message(seat: number, text: string): void };
      catalog(): { cards: Record<string, Record<string, string>> };
    };
  }
}

export async function extractRegions(): Promise<{
  regions: Region[];
  viewport: { width: number; height: number; devicePixelRatio: number };
  deck: string;
}> {
  const state = window.poker.getState();
  const regions: Region[] = [];
  const targets = new Map<string, Element>();
  const textBounds = (range: Range, el: Element) => {
    const r = range.getBoundingClientRect();
    if (range.getClientRects().length !== 1) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT),
        rects: DOMRect[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim()) continue;
        const child = document.createRange();
        child.selectNodeContents(node);
        const b = child.getBoundingClientRect(),
          ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = getComputedStyle(node.parentElement ?? el).font;
        const m = ctx.measureText(node.textContent);
        rects.push(
          new DOMRect(
            b.x,
            b.y + m.fontBoundingBoxAscent - m.actualBoundingBoxAscent,
            b.width,
            m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
          ),
        );
      }
      if (rects.length) {
        const x = Math.min(...rects.map((b) => b.x)),
          y = Math.min(...rects.map((b) => b.y));
        return new DOMRect(
          x,
          y,
          Math.max(...rects.map((b) => b.right)) - x,
          Math.max(...rects.map((b) => b.bottom)) - y,
        );
      }
      return r;
    }
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = getComputedStyle(el).font;
    const metrics = ctx.measureText(range.toString());
    if (
      !Number.isFinite(metrics.fontBoundingBoxAscent) ||
      metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent <= 0
    )
      return r;
    const baseline = r.y + metrics.fontBoundingBoxAscent;
    return new DOMRect(
      r.x,
      baseline - metrics.actualBoundingBoxAscent,
      r.width,
      metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
    );
  };
  const visible = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.display === "none" || css.visibility !== "visible" || Number(css.opacity) === 0) {
        return false;
      }
    }
    return el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  };
  const rectangle = (b: Bounds): Point[] => [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ];
  const add = (
    id: string,
    category: string,
    el: Element | null,
    seat: number | null = null,
    textOnly = true,
  ): Region => {
    const template =
      seat === null
        ? null
        : (document
            .querySelector(`[data-seat="${seat}"]`)
            ?.className.match(/seat-template-(\d+)/)?.[1] ?? null);
    const region: Region = {
      id,
      category,
      seat,
      template,
      cardSlot: null,
      label: null,
      bounds: null,
      polygon: null,
      rotation: 0,
      visibility: "absent",
      reason: "not rendered",
      labelEvidence: "controlled_render_state",
      visuallyVerified: false,
    };
    regions.push(region);
    if (el) targets.set(id, el);
    if (!el || !visible(el)) return region;
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = textOnly ? textBounds(range, el) : el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return region;
    region.label = textOnly ? (el.textContent?.trim() ?? "") : null;
    const b = { x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 };
    region.bounds = b;
    region.polygon = rectangle(b);
    region.visibility = "visible";
    region.reason = null;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const css = getComputedStyle(node);
      const clip = node.getBoundingClientRect();
      if (
        ["hidden", "clip", "scroll", "auto"].includes(css.overflowX) &&
        (r.left < clip.left - 0.5 || r.right > clip.right + 0.5)
      ) {
        region.visibility = "unsupported";
        region.reason =
          "rendered text clipped by ancestor; full state text is not a valid pixel label";
      }
      if (
        ["hidden", "clip", "scroll", "auto"].includes(css.overflowY) &&
        (r.top < clip.top - 0.5 || r.bottom > clip.bottom + 0.5)
      ) {
        region.visibility = "unsupported";
        region.reason = "rendered text vertically clipped by ancestor";
      }
    }
    if (b.x < 0 || b.y < 0 || b.x + b.width > innerWidth || b.y + b.height > innerHeight) {
      region.visibility = "unsupported";
      region.reason = "crop extends outside viewport";
    }
    return region;
  };
  const query = (s: string) => document.querySelector(s);
  for (let seat = 0; seat < 9; seat++) {
    const base = `[data-seat="${seat}"]`;
    for (const [category, selector] of [
      ["name", ".player-name"],
      ["winner", ".winner-message"],
      ["bank", ".player-cash span"],
      ["action", ".player-action .text"],
      ["status", ".r-player-state .text"],
      ["combination", ".seat-combination-names .names"],
      ["award", ".PlayerWonContainer__funds__text"],
      ["timer", ".countdown .text"],
      ["popup", ".message-content"],
    ])
      add(`seat.${seat}.${category}`, category, query(`${base} ${selector}`), seat);
    add(`seat.${seat}.bet`, "bet", query(`[data-bet-seat="${seat}"] .value`), seat);
    add(
      `seat.${seat}.timer_bar`,
      "timer_bar",
      query(`${base} .SeatTimerContainer .bar`),
      seat,
      false,
    );
    const active = add(
      `seat.${seat}.active`,
      "active",
      query(`${base} .r-player.active .r-player-bar`),
      seat,
      false,
    );
    active.semanticValue = state.active === seat ? "active" : null;
  }
  add("pot.total", "pot", query(".bank-container .value"));
  for (let i = 0; i < 10; i++) {
    add(`pot.${i}`, "split_pot", query(`[data-pot-index="${i}"] .value`));
  }
  add("game.id", "game_id", query(".game-id"));
  add("table.info", "table_info", query(".table-name"));
  add("game.high_hand", "high_hand", query(".high-hand"));
  add("dealer", "dealer", query(".dealer-button"), null, false).semanticValue =
    state.dealer ?? null;
  add(
    "header.timer",
    "timer",
    query(".TableIndicator.active .Timer__canvas"),
    null,
    false,
  ).semanticValue = state.timer?.remaining ?? null;

  const glyphCache = new Map<string, { rank: Bounds; suit: Bounds }>();
  const glyphs = async (face: Element | string) => {
    const url =
      typeof face === "string"
        ? new URL(face, location.href).href
        : getComputedStyle(face).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    if (!url) throw new Error("card face has no image");
    const asset = new URL(url, location.href);
    if (asset.origin !== location.origin) throw new Error("card asset is not same-origin");
    const cached = glyphCache.get(url);
    if (cached) return cached;
    const response = await fetch(asset);
    if (!response.ok) throw new Error("card asset unavailable");
    const parsed = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
    const source = parsed.documentElement;
    const vb = source.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
    if (!vb || vb.length !== 4 || vb[2] !== 32 || vb[3] !== 44)
      throw new Error("unsupported card image geometry");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(svg);
    try {
      const candidates: Bounds[] = [];
      for (const path of source.querySelectorAll("path")) {
        if (path.closest("defs")) continue;
        if (path.parentElement?.getAttribute("transform") || path.getAttribute("transform"))
          throw new Error("unsupported glyph transform");
        const clone = document.createElementNS(svg.namespaceURI, "path") as SVGPathElement;
        clone.setAttribute("d", path.getAttribute("d") ?? "");
        svg.append(clone);
        const b = clone.getBBox();
        if (b.x >= 0 && b.x + b.width <= 13 && b.y >= 0 && b.y + b.height <= 24) {
          candidates.push({ x: b.x, y: b.y, width: b.width, height: b.height });
        }
      }
      const group = (suit: boolean): Bounds => {
        const found = candidates.filter((b) => (suit ? b.y >= 12 : b.y + b.height <= 13));
        if (!found.length) throw new Error("rank/suit glyph unavailable");
        const x = Math.min(...found.map((b) => b.x)) - 0.5;
        const y = Math.min(...found.map((b) => b.y)) - 0.5;
        return {
          x: x / 32,
          y: y / 44,
          width: (Math.max(...found.map((b) => b.x + b.width)) + 0.5 - x) / 32,
          height: (Math.max(...found.map((b) => b.y + b.height)) + 0.5 - y) / 44,
        };
      };
      const result = { rank: group(false), suit: group(true) };
      glyphCache.set(url, result);
      return result;
    } finally {
      svg.remove();
    }
  };
  const deck = window.poker.catalog().cards[state.theme.cards];
  if (!deck || Object.keys(deck).length !== 52)
    throw new Error("The selected deck must expose all52card faces");
  const deckGlyphs = await Promise.all(Object.values(deck).map(glyphs));
  const union = (items: Bounds[]): Bounds => {
    const x = Math.min(...items.map((b) => b.x)),
      y = Math.min(...items.map((b) => b.y));
    return {
      x,
      y,
      width: Math.max(...items.map((b) => b.x + b.width)) - x,
      height: Math.max(...items.map((b) => b.y + b.height)) - y,
    };
  };
  const glyphEnvelope = {
    rank: union(deckGlyphs.map((g) => g.rank)),
    suit: union(deckGlyphs.map((g) => g.suit)),
  };
  const card = async (
    el: Element | null,
    id: string,
    value: string | null,
    seat: number | null,
    slot: number,
  ) => {
    for (const category of ["rank", "suit"] as const) {
      const region = add(`${id}.${category}`, category, null, seat, false);
      region.cardSlot = slot;
      if (!el || !visible(el) || !value || value === "back" || value === "?") {
        region.reason = "card is absent or face down";
        continue;
      }
      try {
        targets.set(region.id, el);
        if (!/^[2-9TJQKA][shdc]$/.test(value)) throw new Error("unsupported controlled card code");
        const face = el.querySelector(".face");
        if (!face) throw new Error("card face unavailable");
        const faceTransform = new DOMMatrix(getComputedStyle(face).transform);
        if (!faceTransform.isIdentity) throw new Error("card face is flipping or hidden");
        const ink = (await glyphs(face))[category];
        const b = glyphEnvelope[category];
        const css = getComputedStyle(el);
        const matrix = new DOMMatrix(css.transform === "none" ? undefined : css.transform);
        if (!matrix.is2D || Math.abs(matrix.a * matrix.d - matrix.b * matrix.c - 1) > 0.01)
          throw new Error("card is in non-rigid animation");
        const r = el.getBoundingClientRect();
        const width = parseFloat(css.width),
          height = parseFloat(css.height);
        const scaleX = Math.hypot(matrix.a, matrix.b),
          scaleY = Math.hypot(matrix.c, matrix.d);
        const enclosingWidth = Math.abs(matrix.a * width) + Math.abs(matrix.c * height);
        const enclosingHeight = Math.abs(matrix.b * width) + Math.abs(matrix.d * height);
        const outerScaleX = r.width / enclosingWidth,
          outerScaleY = r.height / enclosingHeight;
        if (Math.abs(outerScaleX - outerScaleY) > 0.02)
          throw new Error("unsupported ancestor transform");
        const map = (x: number, y: number): Point => ({
          x:
            r.x +
            r.width / 2 +
            ((x - 0.5) * width * matrix.a + (y - 0.5) * height * matrix.c) * outerScaleX,
          y:
            r.y +
            r.height / 2 +
            ((x - 0.5) * width * matrix.b + (y - 0.5) * height * matrix.d) * outerScaleY,
        });
        const polygon = [
          map(b.x, b.y),
          map(b.x + b.width, b.y),
          map(b.x + b.width, b.y + b.height),
          map(b.x, b.y + b.height),
        ];
        const inkPolygon = [
          map(ink.x, ink.y),
          map(ink.x + ink.width, ink.y),
          map(ink.x + ink.width, ink.y + ink.height),
          map(ink.x, ink.y + ink.height),
        ];
        region.inkPolygon = inkPolygon;
        const ix = Math.min(...inkPolygon.map((p) => p.x)),
          iy = Math.min(...inkPolygon.map((p) => p.y));
        region.inkBounds = {
          x: ix,
          y: iy,
          width: Math.max(...inkPolygon.map((p) => p.x)) - ix,
          height: Math.max(...inkPolygon.map((p) => p.y)) - iy,
        };
        region.envelope = {
          policy: "complete_deck_glyph_union",
          limit: "52card faces in the selected deck",
          clippedToViewport: false,
        };
        region.label =
          category === "rank"
            ? value.slice(0, -1) === "T"
              ? "10"
              : value.slice(0, -1)
            : ({ s: "♠", h: "♥", d: "♦", c: "♣" }[value.slice(-1)] ?? null);
        region.polygon = polygon;
        const x = Math.min(...polygon.map((p) => p.x)),
          y = Math.min(...polygon.map((p) => p.y));
        region.bounds = {
          x,
          y,
          width: Math.max(...polygon.map((p) => p.x)) - x,
          height: Math.max(...polygon.map((p) => p.y)) - y,
        };
        region.rotation = (Math.atan2(matrix.b * scaleY, matrix.a * scaleX) * 180) / Math.PI;
        region.visibility = "visible";
        region.reason = null;
        if (polygon.some((p) => p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight))
          throw new Error("card glyph extends outside viewport");
      } catch (error) {
        region.visibility = "unsupported";
        region.reason = String(error);
      }
    }
  };
  for (let seat = 0; seat < 9; seat++) {
    const cards = [...document.querySelectorAll(`[data-seat="${seat}"] .r-card`)];
    for (let i = 0; i < Math.max(2, state.seats[seat]?.cards.length ?? 0); i++)
      await card(
        cards[i] ?? null,
        `seat.${seat}.card.${i}`,
        state.seats[seat]?.cards[i] ?? null,
        seat,
        i,
      );
  }
  const board = [...document.querySelectorAll(".r-table-cards .r-card")];
  for (let i = 0; i < 5; i++)
    await card(board[i] ?? null, `board.${i}`, state.board[i] ?? null, null, i);
  const hitStyle = document.createElement("style");
  hitStyle.textContent = "* { pointer-events: auto !important; }";
  document.head.append(hitStyle);
  try {
    const painted = [...document.querySelectorAll("body *")]
      .filter((el) => {
        if (!visible(el)) return false;
        const css = getComputedStyle(el);
        return (
          css.backgroundImage !== "none" ||
          !["rgba(0, 0, 0, 0)", "transparent"].includes(css.backgroundColor) ||
          ["IMG", "CANVAS", "SVG", "VIDEO"].includes(el.tagName) ||
          [...el.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          )
        );
      })
      .map((el) => ({ el, rect: el.getBoundingClientRect() }));
    for (const region of regions) {
      if (region.visibility !== "visible" || !region.bounds || !region.polygon) continue;
      if (region.label === null) continue;
      const target = targets.get(region.id);
      if (!target) continue;
      const b = region.inkBounds ?? region.bounds;
      for (const candidate of painted) {
        if (target.contains(candidate.el) || candidate.el.contains(target)) continue;
        const left = Math.max(b.x, candidate.rect.left),
          right = Math.min(b.x + b.width, candidate.rect.right);
        const top = Math.max(b.y, candidate.rect.top),
          bottom = Math.min(b.y + b.height, candidate.rect.bottom);
        if (right - left < 0.5 || bottom - top < 0.5) continue;
        const points = [
          { x: (left + right) / 2, y: (top + bottom) / 2 },
          { x: left + 0.25, y: top + 0.25 },
          { x: right - 0.25, y: top + 0.25 },
          { x: right - 0.25, y: bottom - 0.25 },
          { x: left + 0.25, y: bottom - 0.25 },
        ];
        for (const point of points) {
          const polygon = region.inkPolygon ?? region.polygon;
          if (
            !polygon.every((a, i) => {
              const next = polygon[(i + 1) % polygon.length];
              return (next.x - a.x) * (point.y - a.y) - (next.y - a.y) * (point.x - a.x) >= -0.1;
            })
          )
            continue;
          const stack = document.elementsFromPoint(point.x, point.y);
          const ownIndex = stack.findIndex((el) => el === target || target.contains(el));
          const otherIndex = stack.indexOf(candidate.el);
          if (ownIndex >= 0 && otherIndex >= 0 && otherIndex < ownIndex) {
            region.visibility = "unsupported";
            region.reason = `crop intersects a foreground element: ${candidate.el.tagName}.${candidate.el.className}`;
            break;
          }
        }
        if (region.visibility === "unsupported") break;
      }
    }
  } finally {
    hitStyle.remove();
  }
  const px = (value: string) => parseFloat(value) || 0;
  const moneyWidth = (el: Element) => {
    const css = getComputedStyle(el),
      ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = css.font;
    const digit = Math.max(...[..."0123456789"].map((d) => ctx.measureText(d).width));
    const numeric = 24 * digit + 5 * ctx.measureText(",").width + ctx.measureText(". BB$P+").width;
    const size = px(css.fontSize);
    return Math.ceil(numeric + size * 1.4 + px(css.paddingLeft) + px(css.paddingRight) + 4);
  };
  const asBounds = (r: DOMRect): Bounds => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  for (const region of regions) {
    if (region.category === "rank" || region.category === "suit") continue;
    region.inkBounds = region.bounds;
    region.inkPolygon = region.polygon;
    const el = targets.get(region.id);
    if (!el) continue;
    let b: Bounds | null = null;
    let policy = "fixed_css_allocation";
    let limit = "current layout allocation; content beyond it is unsupported";
    const css = getComputedStyle(el);
    if (["name", "winner", "bank"].includes(region.category)) {
      b = asBounds((el.closest(".bar-text") ?? el).getBoundingClientRect());
    } else if (region.category === "bet") {
      const anchor = el.closest(".text");
      if (anchor) {
        const r = anchor.getBoundingClientRect(),
          justify = getComputedStyle(anchor).justifyContent,
          width = moneyWidth(el);
        b = {
          x:
            justify === "flex-start"
              ? r.x
              : justify === "flex-end"
                ? r.right - width
                : r.x + (r.width - width) / 2,
          y: r.y,
          width,
          height: r.height,
        };
      }
      policy = "safe_funds_formatter";
      limit =
        "safe integer native funds;0..8fraction digits;grouping;BB or built-in currency;no custom currencyFormat";
    } else if (region.category === "pot") {
      const anchor = el.closest(".bank-container");
      if (anchor) {
        const r = anchor.getBoundingClientRect(),
          title = anchor.querySelector(".title")?.getBoundingClientRect().width ?? 0,
          width = moneyWidth(el);
        b = { x: r.x + r.width / 2 + title / 2 - width / 2, y: r.y, width, height: r.height };
      }
      policy = "safe_funds_formatter";
      limit = "safe integer native funds;built-in BB/currency formats";
    } else if (region.category === "split_pot") {
      const area = query(".r-game-area")?.getBoundingClientRect(),
        group = el.closest(".ReactPokerPotsContainer__chips");
      if (area && group) {
        const g = group.getBoundingClientRect(),
          font = px(getComputedStyle(group).fontSize),
          count = document.querySelectorAll("[data-pot-index]").length;
        const width = Math.min(area.width, px(getComputedStyle(group).maxWidth) || area.width);
        const rowHeight = Math.max(
          font * 2.5,
          el.closest(".ReactPokerPotsContainer__chip")?.getBoundingClientRect().height ?? 0,
        );
        b = {
          x: area.x + (area.width - width) / 2,
          y: g.y,
          width,
          height: rowHeight * 10,
        };
      }
      policy = "shared_wrapping_pot_allocation";
      limit = "up to10pots;CSS max-width and one row per pot;slots can share potential bounds";
    } else if (region.category === "table_info") {
      b = asBounds(el.getBoundingClientRect());
      b.height = Math.max(b.height, px(css.lineHeight) || px(css.fontSize) * 1.2);
      limit =
        "single rendered table line inside its76%CSS allocation;tableName<=200UTF16units;overflow/wrapping unsupported";
    } else if (region.category === "game_id" || region.category === "high_hand") {
      const parent = el.parentElement?.getBoundingClientRect(),
        r = el.getBoundingClientRect();
      if (parent) {
        const maxWidth = px(css.maxWidth),
          lineHeight = px(css.lineHeight) || px(css.fontSize) * 1.4;
        const width =
          region.category === "high_hand" && maxWidth
            ? Math.min(maxWidth, parent.width)
            : parent.width;
        const height = region.category === "game_id" ? r.height : lineHeight;
        b = {
          x: region.category === "high_hand" ? parent.right - px(css.right) - width : parent.x,
          y: region.category === "high_hand" ? parent.bottom - px(css.bottom) - height : r.y,
          width,
          height,
        };
      }
      policy = "visible_header_allocation";
      limit =
        "text<=200UTF16units;single line inside available header allocation;overflow unsupported";
    } else if (region.category === "timer") {
      const r = el.getBoundingClientRect();
      if (el instanceof HTMLCanvasElement) b = asBounds(r);
      else {
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = css.font;
        const digit = Math.max(...[..."0123456789"].map((d) => ctx.measureText(d).width));
        const width = Math.ceil(24 * digit + ctx.measureText(".e+").width + 4);
        b = { x: r.x + (r.width - width) / 2, y: r.y, width, height: r.height };
      }
      policy = "finite_numeric_timer";
      limit =
        "Math.trunc(finite nonnegative number):up to21decimal integer digits or17significant digits plus exponent";
    } else if (region.category === "action" || region.category === "status") {
      const parent = el.closest(".player-action,.r-player-state");
      if (parent) b = asBounds(parent.getBoundingClientRect());
      limit =
        "single line inside the seat CSS allocation;uncapped custom strings that overflow are unsupported";
    } else if (region.category === "popup") {
      const message = el.closest(".message");
      if (message) {
        const m = message.getBoundingClientRect(),
          max = px(getComputedStyle(message).maxWidth);
        const typed = (message as HTMLElement).computedStyleMap();
        if (typed.get("width")?.toString() !== "auto" && typed.get("height")?.toString() !== "auto")
          b = asBounds(m);
        else if (max && css.whiteSpace === "nowrap")
          b = { x: m.x + (m.width - max) / 2, y: m.y, width: max, height: m.height };
      }
      policy = "bounded_popup_allocation";
      limit =
        "only CSS-nowrap bubbles with finite max-width;wrapping bubble height has no isolated maximum";
    } else if (region.category === "combination") {
      const allocation = el.closest(".seat-combination-names");
      if (allocation) b = asBounds(allocation.getBoundingClientRect());
      limit =
        "fixed CSS combination slot;uncapped fragments/rows beyond its visible allocation are unsupported";
    } else if (region.category === "award") {
      const seat = el.closest("[data-seat]")?.getBoundingClientRect(),
        r = el.getBoundingClientRect(),
        width = moneyWidth(el);
      if (seat) b = { x: seat.x + (seat.width - width) / 2, y: r.y, width, height: r.height };
      policy = "safe_funds_formatter";
      limit = "safe integer native funds;built-in BB/currency formats";
    } else if (region.label === null) b = asBounds(el.getBoundingClientRect());
    if (!b) {
      region.bounds = null;
      region.polygon = null;
      region.envelope = {
        policy: "unsupported_unbounded_layout",
        limit: "no finite isolated CSS allocation for this arbitrary text profile",
        clippedToViewport: false,
      };
      if (region.visibility === "visible") {
        region.visibility = "unsupported";
        region.reason = "no finite isolated content envelope for this layout/profile";
      }
      continue;
    }
    if (
      ["safe_funds_formatter", "shared_wrapping_pot_allocation"].includes(policy) &&
      state.currencyFormat !== undefined &&
      !["{0}", "${0}", "{value}", "${value}"].includes(state.currencyFormat)
    ) {
      region.visibility = "unsupported";
      region.reason = "custom currencyFormat has no supported finite envelope";
    }
    region.bounds = b;
    region.polygon = rectangle(b);
    const clipped =
      b.x < 0 || b.y < 0 || b.x + b.width > innerWidth || b.y + b.height > innerHeight;
    region.envelope = { policy, limit, clippedToViewport: clipped };
    const ink = region.inkBounds;
    if (
      region.visibility === "visible" &&
      region.label !== null &&
      ink &&
      (ink.x < b.x - 0.5 ||
        ink.y < b.y - 0.5 ||
        ink.x + ink.width > b.x + b.width + 0.5 ||
        ink.y + ink.height > b.y + b.height + 0.5)
    ) {
      region.visibility = "unsupported";
      region.reason = "current content exceeds the supported maximum layout envelope";
    }
    if (clipped) {
      const x = Math.max(0, b.x),
        y = Math.max(0, b.y);
      const bounded = {
        x,
        y,
        width: Math.max(0, Math.min(innerWidth, b.x + b.width) - x),
        height: Math.max(0, Math.min(innerHeight, b.y + b.height) - y),
      };
      region.cropBounds = bounded;
    } else region.cropBounds = b;
    if (b.width <= 0 || b.height <= 0) {
      region.visibility = "unsupported";
      region.reason = "empty maximum-content envelope";
    }
  }
  for (const region of regions) {
    const b = region.bounds;
    region.cropOverlaps = [];
    if (b && region.label !== null) {
      for (const other of regions) {
        if (other === region || !other.inkBounds || other.visibility === "absent") continue;
        if (other.label === null && other.category !== "dealer") continue;
        const ink = other.inkBounds;
        if (
          Math.min(b.x + b.width, ink.x + ink.width) - Math.max(b.x, ink.x) > 0.5 &&
          Math.min(b.y + b.height, ink.y + ink.height) - Math.max(b.y, ink.y) > 0.5
        )
          region.cropOverlaps.push(other.id);
      }
    }
    region.autoLabelEligible =
      region.visibility === "visible" && region.label !== null && region.cropOverlaps.length === 0;
    region.cropLabel = region.autoLabelEligible ? region.label : null;
  }
  return {
    regions,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    deck: state.theme.cards,
  };
}
