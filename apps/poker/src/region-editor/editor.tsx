import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button, Input } from "@unimatrix/ui";
import type { PokerRegions, PokerRegionEditorSave } from "@unimatrix/shared";
import { loadEditorConfig, saveEditorConfig } from "./api.js";
import {
  drawnBox,
  editorRegions,
  fitView,
  formatVideoTime,
  nextUndefined,
  regionColors,
  zoomAt,
  type EditorView,
  type Point,
} from "./geometry.js";

interface MediaFile {
  file: File;
  url: string;
  name: string;
  video: boolean;
}
interface Dimensions {
  width: number;
  height: number;
}
interface Drag {
  start: Point;
  current: Point;
  client: Point;
  pan: Point;
  panning: boolean;
}
const definitions = editorRegions();
const initialView: EditorView = { scale: 1, offX: 0, offY: 0, zoom: 1, panX: 0, panY: 0 };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function RegionEditor() {
  const [defined, setDefined] = useState<PokerRegions>({});
  const [active, setActive] = useState(0);
  const [media, setMedia] = useState<MediaFile[]>([]);
  const [mediaIndex, setMediaIndex] = useState(0);
  const [natural, setNatural] = useState<Dimensions>({ width: 1920, height: 1080 });
  const [view, setView] = useState(initialView);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [status, setStatus] = useState("Loading...");
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playGlyph, setPlayGlyph] = useState("⏸");
  const [exporting, setExporting] = useState(false);
  const wrap = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    video = useRef<HTMLVideoElement>(null),
    filePicker = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const currentDefined = useRef(defined),
    dimensions = useRef<Dimensions>({ width: 1920, height: 1080 });
  const imageDimensions = useRef<Promise<Dimensions>>(Promise.resolve(dimensions.current));
  const edited = useRef(false),
    alive = useRef(true),
    mediaUrls = useRef<string[]>([]),
    saveVersion = useRef(0);
  const current = media[mediaIndex];
  const selected = definitions[active];

  useEffect(() => {
    alive.current = true;
    void loadEditorConfig()
      .then((saved) => {
        if (!alive.current || edited.current) return;
        currentDefined.current = saved.regions;
        setDefined(saved.regions);
        dimensions.current = { width: saved.screenWidth, height: saved.screenHeight };
        imageDimensions.current = Promise.resolve(dimensions.current);
        setActive(nextUndefined(definitions, saved.regions));
        setStatus("");
      })
      .catch((cause: unknown) => {
        if (alive.current) {
          setStatus("LOAD ERROR!");
          setError(errorText(cause));
        }
      });
    return () => {
      alive.current = false;
      mediaUrls.current.forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, []);
  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const fit = () => {
      setView((previous) =>
        fitView(element.clientWidth, element.clientHeight, natural.width, natural.height, previous),
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [natural]);

  function queueSave(regions: PokerRegions) {
    const sequence = ++saveVersion.current;
    const task = async () => {
      if (alive.current) {
        setStatus("Saving...");
        setError("");
      }
      const size = await imageDimensions.current;
      await saveEditorConfig({ regions, screenWidth: size.width, screenHeight: size.height });
      if (alive.current && sequence === saveVersion.current) {
        setStatus("Saved");
        setTimeout(() => {
          if (alive.current && sequence === saveVersion.current)
            setStatus((value) => (value === "Saved" ? "" : value));
        }, 1000);
      }
    };
    queue.current = queue.current.catch(() => {}).then(task);
    void queue.current.catch((cause: unknown) => {
      if (alive.current) {
        setStatus("SAVE ERROR!");
        setError(errorText(cause));
      }
    });
  }
  function changeRegions(regions: PokerRegions) {
    edited.current = true;
    currentDefined.current = regions;
    setDefined(regions);
    queueSave(regions);
  }
  function clearSelected() {
    if (!selected) return;
    changeRegions(
      Object.fromEntries(
        Object.entries(currentDefined.current).filter(([key]) => key !== selected.key),
      ),
    );
  }
  function openFiles(files: FileList | null) {
    if (!files?.length) return;
    mediaUrls.current.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    const items = Array.from(files)
      .map((file) => ({
        file,
        url: URL.createObjectURL(file),
        name: file.webkitRelativePath || file.name,
        video: file.type.startsWith("video/") || /\.(mp4|mkv|webm|mov|avi)$/i.test(file.name),
      }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    mediaUrls.current = items.map((item) => item.url);
    setMedia(items);
    setMediaIndex(0);
    setError("");
    const firstImage = items.find((item) => !item.video);
    imageDimensions.current = firstImage
      ? new Promise<Dimensions>((resolve, reject) => {
          const image = new Image();
          image.onload = () => {
            resolve({ width: image.naturalWidth, height: image.naturalHeight });
          };
          image.onerror = () => {
            reject(new Error("The first reference image could not be decoded."));
          };
          image.src = firstImage.url;
        })
      : Promise.resolve({ width: 1920, height: 1080 });
    void imageDimensions.current
      .then((size) => {
        dimensions.current = size;
      })
      .catch((cause: unknown) => {
        setError(errorText(cause));
      });
  }
  function navigateMedia(delta: number) {
    if (media.length) {
      video.current?.pause();
      setMediaIndex((value) => (value + delta + media.length) % media.length);
      setPosition(0);
      setDuration(0);
      setPlaying(false);
    }
  }
  function seek(time: number) {
    if (video.current) {
      const maximum = Number.isFinite(video.current.duration) ? video.current.duration : Infinity;
      video.current.currentTime = Math.max(0, Math.min(maximum, time));
      setPosition(video.current.currentTime);
    }
  }
  function playPause() {
    const element = video.current;
    if (!element) return;
    if (element.paused) {
      void element
        .play()
        .then(() => {
          setPlaying(true);
          setPlayGlyph("⏸");
        })
        .catch((cause: unknown) => {
          setError(errorText(cause));
        });
    } else {
      element.pause();
      setPlaying(false);
      setPlayGlyph("▶");
    }
  }
  async function exportRegions() {
    setExporting(true);
    setError("");
    setStatus("Finalizing saves...");
    try {
      await queue.current;
      const size = await imageDimensions.current;
      const payload: PokerRegionEditorSave = {
        regions: currentDefined.current,
        screenWidth: size.width,
        screenHeight: size.height,
        export: true,
      };
      setStatus("Exporting...");
      const result = await saveEditorConfig(payload);
      setStatus("Exported!");
      window.alert(
        `Exported to: ${result.exportPath ?? "shared regions.json"}\n${Object.keys(currentDefined.current).length}/${definitions.length} regions defined.`,
      );
    } catch (cause) {
      setStatus("EXPORT ERROR");
      setError(errorText(cause));
    } finally {
      if (alive.current) setExporting(false);
    }
  }

  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      setView((previous) =>
        zoomAt(
          previous,
          { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
          event.deltaY,
        ),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
    };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowLeft" && !current?.video) navigateMedia(-1);
      if (event.key === "ArrowRight" && !current?.video) navigateMedia(1);
      if (event.key === "[") navigateMedia(-1);
      if (event.key === "]") navigateMedia(1);
      if (event.key === " " && current?.video) {
        event.preventDefault();
        playPause();
      }
      if (event.key === "ArrowLeft" && current?.video) {
        event.preventDefault();
        seek((video.current?.currentTime ?? 0) - 1 / 30);
      }
      if (event.key === "ArrowRight" && current?.video) {
        event.preventDefault();
        seek((video.current?.currentTime ?? 0) + 1 / 30);
      }
      if (event.key === "Tab") {
        event.preventDefault();
        setActive(nextUndefined(definitions, currentDefined.current, active));
      }
      if (event.key === "Delete" || event.key === "Backspace") clearSelected();
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
    };
  });
  useEffect(() => {
    const element = canvas.current,
      context = element?.getContext("2d");
    if (!element || !context || !wrap.current) return;
    element.width = wrap.current.clientWidth;
    element.height = wrap.current.clientHeight;
    context.clearRect(0, 0, element.width, element.height);
    context.save();
    context.translate(view.panX, view.panY);
    context.scale(view.zoom, view.zoom);
    for (const [key, box] of Object.entries(defined)) {
      const color = regionColors[key.split(".")[0] as keyof typeof regionColors] || "#a78bfa";
      const selectedBox = selected?.key === key;
      const x = box.x * view.scale + view.offX,
        y = box.y * view.scale + view.offY,
        width = box.w * view.scale,
        height = box.h * view.scale;
      context.strokeStyle = color;
      context.lineWidth = (selectedBox ? 2.5 : 1.5) / view.zoom;
      if (selectedBox) {
        context.fillStyle = `${color}22`;
        context.fillRect(x, y, width, height);
      }
      context.strokeRect(x, y, width, height);
      context.fillStyle = color;
      context.font = `${9 / view.zoom}px Consolas`;
      context.fillText(key.split(".").at(-1) ?? key, x + 2 / view.zoom, y + 10 / view.zoom);
    }
    context.restore();
    if (drag && !drag.panning) {
      context.strokeStyle = regionColors[selected?.cat ?? "seat"];
      context.lineWidth = 2;
      context.setLineDash([5, 4]);
      context.strokeRect(
        Math.min(drag.start.x, drag.current.x),
        Math.min(drag.start.y, drag.current.y),
        Math.abs(drag.current.x - drag.start.x),
        Math.abs(drag.current.y - drag.start.y),
      );
      context.setLineDash([]);
    }
  }, [defined, drag, selected, view]);

  const localPoint = (event: PointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  const draftBox = drag && !drag.panning ? drawnBox(drag.start, drag.current, view) : null;
  return (
    <>
      <aside id="sidebar">
        <h2>
          REGIONS &nbsp;<span id="dc">{Object.keys(defined).length}</span>/
          <span id="tc">{definitions.length}</span>
        </h2>
        <div id="region-list">
          {definitions.map((region, index) => (
            <Button
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              key={region.key}
              className={`ri${active === index ? " active" : ""}${defined[region.key] ? " done" : ""}`}
              variant="ghost"
              style={{ borderLeftColor: regionColors[region.cat] }}
              onClick={() => {
                setActive(index);
              }}
              aria-pressed={active === index}
            >
              {region.label}
            </Button>
          ))}
        </div>
        <div id="sf">
          <Button id="bc" onClick={clearSelected}>
            Clear selected box
          </Button>
          <Button
            id="be"
            disabled={exporting}
            onClick={() => {
              void exportRegions();
            }}
          >
            Export regions_final.json
          </Button>
        </div>
      </aside>
      <main id="main">
        <header id="info">
          <span id="cur" style={{ color: selected ? regionColors[selected.cat] : undefined }}>
            {selected ? `Drawing: ${selected.label}` : "← Select a region to draw"}
          </span>
          <span
            id="status"
            role="status"
            title={error}
            style={{ color: error ? "#f87171" : status === "Exported!" ? "#22c55e" : "#64748b" }}
          >
            {status}
            {error ? ` ${error}` : ""}
          </span>
          <span id="tag">
            {draftBox ? `${draftBox.w}×${draftBox.h}px @ ${draftBox.x},${draftBox.y}` : ""}
          </span>
        </header>
        <div id="wrap" ref={wrap}>
          <img
            className="bg"
            id="bgimg"
            alt="Reference screenshot"
            src={current && !current.video ? current.url : undefined}
            style={{ display: current && !current.video ? "block" : "none", transform }}
            onLoad={(event) => {
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
            }}
          />
          <video
            id="bgvid"
            ref={video}
            src={current?.video ? current.url : undefined}
            preload="auto"
            style={{ display: current?.video ? "block" : "none", transform }}
            onLoadedMetadata={(event) => {
              setNatural({
                width: event.currentTarget.videoWidth,
                height: event.currentTarget.videoHeight,
              });
              setDuration(event.currentTarget.duration);
            }}
            onDurationChange={(event) => {
              setDuration(event.currentTarget.duration);
            }}
            onTimeUpdate={(event) => {
              setPosition(event.currentTarget.currentTime);
            }}
            onPlay={() => {
              setPlaying(true);
            }}
            onPause={() => {
              setPlaying(false);
            }}
            onError={() => {
              if (current?.video) setError(`Video error — ${current.name}`);
            }}
          />
          <canvas id="c" ref={canvas} aria-label="Region annotations" />
          <div
            className="hit"
            id="hit"
            role="img"
            aria-label="Region drawing surface"
            data-zoom={view.zoom}
            data-natural-width={natural.width}
            data-natural-height={natural.height}
            onPointerDown={(event) => {
              if (!current) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = localPoint(event);
              setDrag({
                start: point,
                current: point,
                client: { x: event.clientX, y: event.clientY },
                pan: { x: view.panX, y: view.panY },
                panning: event.button === 1 || (event.button === 0 && event.altKey),
              });
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              if (drag.panning)
                setView((previous) => ({
                  ...previous,
                  panX: drag.pan.x + event.clientX - drag.client.x,
                  panY: drag.pan.y + event.clientY - drag.client.y,
                }));
              else setDrag({ ...drag, current: localPoint(event) });
            }}
            onPointerUp={(event) => {
              if (!drag) return;
              if (!drag.panning && selected) {
                const box = drawnBox(drag.start, localPoint(event), view);
                if (box) {
                  const regions = { ...currentDefined.current, [selected.key]: box };
                  changeRegions(regions);
                  setActive(nextUndefined(definitions, regions, active));
                }
              }
              setDrag(null);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              setDrag(null);
            }}
          />
        </div>
        <footer id="bar">
          <Button id="open-media" onClick={() => filePicker.current?.click()}>
            Open media
          </Button>
          <Input
            id="media-picker"
            ref={filePicker}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/bmp,video/*,.mkv,.avi,.mov"
            aria-label="Open reference images or videos"
            onChange={(event) => {
              openFiles(event.currentTarget.files);
            }}
          />
          <Button
            id="pp"
            onClick={() => {
              navigateMedia(-1);
            }}
          >
            ◀ Prev
          </Button>
          <span id="ml">
            {current ? `${current.name} (${mediaIndex + 1}/${media.length})` : "—"}
          </span>
          <Button
            id="np"
            onClick={() => {
              navigateMedia(1);
            }}
          >
            Next ▶
          </Button>
          <div id="vctl" style={{ display: current?.video ? "flex" : "none" }}>
            <Button
              id="vpp"
              aria-label={playing ? "Pause video" : "Play video"}
              onClick={playPause}
            >
              {playGlyph}
            </Button>
            <Input
              id="vseek"
              aria-label="Video position"
              type="range"
              min={0}
              max={
                Number.isFinite(duration)
                  ? Math.max(0, Math.floor(duration))
                  : Math.max(1, Math.floor(position + 1))
              }
              step={1}
              value={Math.floor(position)}
              onChange={(event) => {
                seek(Number(event.target.value));
              }}
            />
            <span id="vtc">
              {formatVideoTime(position)} / {formatVideoTime(duration)}
            </span>
          </div>
        </footer>
      </main>
    </>
  );
}
