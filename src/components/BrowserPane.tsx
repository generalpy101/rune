import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  browserClose,
  browserNav,
  browserNavigate,
  browserOpen,
  browserSetBounds,
  browserSetVisible,
  isWebUrl,
  normalizeAddress,
  type Bounds,
  type BrowserBookmark,
  type BrowserEvent,
} from "../lib/browser";
import {
  IconBack,
  IconForward,
  IconRefresh,
  IconExternal,
  IconClose,
} from "../lib/icons";

export interface BrowserHandle {
  /** Load `url` (http/https) in this pane. */
  navigate: (url: string) => void;
}

interface Props {
  paneId: number;
  /** Last known URL (restored from the session or reported by the page). */
  url: string;
  /** On screen: its tab is active and it isn't hidden by a zoomed sibling.
   *  The native webview exists only while live, so hidden panes cost no RAM. */
  live: boolean;
  /** A Rune modal/palette/menu is open. Native webviews always paint above
   *  the HTML UI, so the page is hidden (not destroyed) meanwhile. */
  covered: boolean;
  focused: boolean;
  /** Changes whenever surrounding chrome may have moved this pane without
   *  resizing it (ResizeObserver only reports size changes). */
  layoutKey: string;
  bookmarks: BrowserBookmark[];
  onPageChange: (url: string, title?: string) => void;
  onFocusRequest: () => void;
  onClose: () => void;
}

/** A message under the toolbar, optionally offering to open `url` externally. */
interface Notice {
  text: string;
  url?: string;
}

/** Address-bar suggestions. Memoized: the list can hold thousands of
 *  bookmarks and the pane re-renders with every App render. */
const BookmarkList = memo(function BookmarkList({
  id,
  bookmarks,
}: {
  id: string;
  bookmarks: BrowserBookmark[];
}) {
  return (
    <datalist id={id}>
      {bookmarks.map((b) => (
        <option key={b.url} value={b.url}>
          {b.folder ? `${b.title} — ${b.folder}` : b.title}
        </option>
      ))}
    </datalist>
  );
});

export const BrowserPane = forwardRef<BrowserHandle, Props>(
  function BrowserPane(
    {
      paneId,
      url,
      live,
      covered,
      focused,
      layoutKey,
      bookmarks,
      onPageChange,
      onFocusRequest,
      onClose,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // URL the webview shows (or will load when created).
    const urlRef = useRef(url);
    const [address, setAddress] = useState(url);
    const editingRef = useRef(false);
    const [loading, setLoading] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [retry, setRetry] = useState(0);
    // A new tab starts blank: no webview until an address is entered.
    const [blank, setBlank] = useState(!url);
    const onPageChangeRef = useRef(onPageChange);
    onPageChangeRef.current = onPageChange;

    // Whether the native webview exists (or its creation is queued).
    const created = useRef(false);
    // Commands are async on the Rust side and could otherwise race (bounds
    // before create, show after close); chain them per pane instead.
    const queue = useRef<Promise<unknown>>(Promise.resolve());
    const run = (op: () => Promise<unknown>) => {
      queue.current = queue.current.then(op).catch(() => {});
    };
    const fail = (e: unknown) =>
      setNotice({ text: `Couldn't show this page: ${e}`, url: urlRef.current });

    const navigate = (next: string) => {
      urlRef.current = next;
      setBlank(false);
      setAddress(next);
      setNotice(null);
      onPageChangeRef.current(next);
      if (created.current) run(() => browserNavigate(paneId, next).catch(fail));
      else setRetry((n) => n + 1);
    };

    useImperativeHandle(ref, () => ({ navigate }), [paneId]);

    // Page state from Rust (navigation, title, blocked links, downloads).
    useEffect(() => {
      const un = listen<BrowserEvent>("browser-event", ({ payload: e }) => {
        if (e.pane !== paneId) return;
        if (e.kind === "blocked") {
          // Blocked URLs are non-http(s), so the opener plugin cannot open them externally.
          setNotice({ text: "This page tried to open a link Rune can't show." });
          return;
        }
        if (e.kind === "download") {
          setNotice({ text: "Downloads aren't supported in Rune.", url: e.url });
          return;
        }
        if (e.kind === "loading") setLoading(true);
        if (e.kind === "loaded") setLoading(false);
        if (!isWebUrl(e.url)) return;
        urlRef.current = e.url;
        if (!editingRef.current) setAddress(e.url);
        onPageChangeRef.current(e.url, e.kind === "title" ? e.title : undefined);
      });
      return () => {
        void un.then((f) => f());
      };
    }, [paneId]);

    // Off-screen (inactive tab/workspace, zoomed sibling): destroy the
    // webview. The URL is kept; site data persists in the browser store.
    useEffect(() => {
      if (live || !created.current) return;
      created.current = false;
      setLoading(false);
      run(() => browserClose(paneId));
    }, [live, paneId]);

    // Closed pane.
    useEffect(
      () => () => {
        created.current = false;
        run(() => browserClose(paneId));
      },
      [paneId],
    );

    const shown = live && !covered;
    useEffect(() => {
      if (!shown) {
        if (created.current) run(() => browserSetVisible(paneId, false));
        return;
      }
      const sync = () => {
        if (!urlRef.current) return;
        const r = viewRef.current?.getBoundingClientRect();
        if (!r || r.width < 1 || r.height < 1) return;
        const b: Bounds = { x: r.left, y: r.top, width: r.width, height: r.height };
        if (created.current) {
          run(() => browserSetBounds(paneId, b));
          return;
        }
        // Lazily create the webview the first time the pane is on screen.
        created.current = true;
        run(() =>
          browserOpen(paneId, urlRef.current, b).catch((e) => {
            created.current = false;
            fail(e);
          }),
        );
      };
      if (created.current) run(() => browserSetVisible(paneId, true));
      sync();
      const ro = new ResizeObserver(sync);
      if (viewRef.current) ro.observe(viewRef.current);
      window.addEventListener("resize", sync);
      return () => {
        ro.disconnect();
        window.removeEventListener("resize", sync);
      };
    }, [shown, paneId, layoutKey, retry]);

    // Taking focus moves it off the terminal so Rune's shortcuts act on this
    // pane (a blank tab focuses its address bar). Skipped while a page holds
    // focus (Rune's UI isn't focused): never pull focus out of the page.
    useEffect(() => {
      const root = rootRef.current;
      if (!focused || !live || !root || !document.hasFocus()) return;
      if (root.contains(document.activeElement)) return;
      if (!urlRef.current) inputRef.current?.focus();
      else root.focus({ preventScroll: true });
    }, [focused, live]);

    const listId = `browser-bookmarks-${paneId}`;

    return (
      <div
        className="browser-pane"
        ref={rootRef}
        tabIndex={-1}
        data-browser-pane={paneId}
        onMouseDown={onFocusRequest}
      >
        <div className="browser-toolbar">
          <button
            className="icon-btn"
            title="Back"
            onClick={() => created.current && run(() => browserNav(paneId, "back"))}
          >
            <IconBack size={14} />
          </button>
          <button
            className="icon-btn"
            title="Forward"
            onClick={() =>
              created.current && run(() => browserNav(paneId, "forward"))
            }
          >
            <IconForward size={14} />
          </button>
          <button
            className="icon-btn"
            title="Reload"
            onClick={() => {
              setNotice(null);
              if (created.current) run(() => browserNav(paneId, "reload"));
              else setRetry((n) => n + 1);
            }}
          >
            <IconRefresh size={14} />
          </button>
          <form
            className={`browser-address${loading ? " loading" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              const next = normalizeAddress(address);
              if (!next) {
                setNotice({ text: "Enter an http or https address." });
                return;
              }
              e.currentTarget.querySelector("input")?.blur();
              navigate(next);
            }}
          >
            <input
              ref={inputRef}
              value={address}
              placeholder="Enter a web address"
              list={bookmarks.length ? listId : undefined}
              spellCheck={false}
              aria-label="Address"
              onFocus={(e) => {
                editingRef.current = true;
                e.currentTarget.select();
              }}
              onBlur={() => {
                editingRef.current = false;
                setAddress(urlRef.current);
              }}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
              }}
            />
          </form>
          {bookmarks.length > 0 && (
            <BookmarkList id={listId} bookmarks={bookmarks} />
          )}
          <button
            className="icon-btn"
            title="Open in default browser"
            onClick={() =>
              urlRef.current && void openUrl(urlRef.current).catch(fail)
            }
          >
            <IconExternal size={14} />
          </button>
          <button className="icon-btn" title="Close pane" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </div>
        {notice && (
          <div className="browser-notice">
            <span>{notice.text}</span>
            {notice.url && (
              <button
                onClick={() => {
                  const target = notice.url!;
                  setNotice(null);
                  void openUrl(target).catch((e) =>
                    setNotice({ text: `Couldn't open it externally: ${e}` }),
                  );
                }}
              >
                Open in default browser
              </button>
            )}
            <button onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        )}
        <div className="browser-view" ref={viewRef}>
          {blank && (
            <div className="browser-blank">Type an address above to open a page.</div>
          )}
        </div>
      </div>
    );
  },
);
