# Tauri desktop applications

Tauri applications target Linux with native Wayland. Their React frontend calls
Rust commands through `invoke`; SQLite access stays in Rust. TanStack Router can
be added when an application needs routes.

## Host prerequisites

Install Rust/Cargo and the Linux development libraries in the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Arch Linux,
GTK3 and WebKitGTK 4.1 provide the system webview. Run development sessions inside
Hyprland with a working Wayland socket. The application must refuse an X11-only
session rather than silently falling back to XWayland.

Keep a stable reverse-domain application identifier. It namespaces stored data
and identifies the window to Hyprland. Changing it creates a different storage
location; moving an existing application's data requires an explicit migration.

## Storage ownership

Rust owns persistence. Frontend state and TanStack Query caches are disposable;
restarting the process must recover saved application data from SQLite.

The storage helpers follow the
[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/):

| Kind | Environment override | Default base |
| --- | --- | --- |
| Durable data and SQLite | `XDG_DATA_HOME` | `$HOME/.local/share` |
| Configuration | `XDG_CONFIG_HOME` | `$HOME/.config` |
| Disposable cache | `XDG_CACHE_HOME` | `$HOME/.cache` |
| Logs and persistent session state | `XDG_STATE_HOME` | `$HOME/.local/state` |

Each base receives an application-specific subdirectory. Empty or relative XDG
values use the default. Runtime sockets belong under `XDG_RUNTIME_DIR`, which
must be supplied by the session; durable data must never go there.

New storage directories use mode `0700` and new SQLite files use `0600`. Existing
permissions are preserved; review them explicitly when adopting an existing data
directory. Database symlinks are rejected.

Keep database queries and file paths inside Rust commands. Expose application
operations instead of arbitrary SQL or frontend-selected filesystem paths. Run
blocking rusqlite work on a blocking worker, and invalidate affected Query keys
only after a successful command.

Append migrations in order. Failed migrations must roll back, and an older binary
must reject a database with a newer schema rather than rewriting its version.

## Shared command boundary

`@unimatrix/tauri` defines commands with input and output validators exposing a
`parse(unknown)` method. Zod schemas satisfy that interface. The command client
validates before transport and again after the Rust result returns. The wire
format passes arguments as `{ input: value }`; Rust handlers must use an `input`
argument with the matching deserializable shape.

Import `tauriTransport` from `@unimatrix/tauri/transport` only in the desktop
frontend. Tests can inject an in-memory transport into `createCommandClient`.
`@unimatrix/tauri/query` supplies `commandQueryOptions` and
`commandMutationOptions` for TanStack Query. Query keys include the command name
and arguments. A mutation's caller owns invalidation of affected queries.

## Rust storage

`unimatrix-desktop`, under `packages/desktop-runtime`, exposes
`AppDirectories::discover(identifier)`, `create()`, and
`database_path(basename)`. Call them during startup before opening the database.
`open_database(path, migrations)` enables foreign keys, sets a busy timeout, and
applies pending SQL migrations in a transaction using SQLite's `user_version`.
The migration array is an append-only sequence of application-owned SQL.

Call `require_native_wayland()` first in `main`, before constructing Tauri or
starting threads. If necessary it re-executes the binary with
`GDK_BACKEND=wayland`; it does not change a multithreaded process environment.
Keep `app.enableGTKAppId` enabled in the Tauri configuration so the identifier is
also registered with GTK. The generated entry point also calls
`glib::set_prgname(Some(IDENTIFIER))` before creating Tauri; the native Hyprland
check required this to give the window its reverse-domain class.

## Create an application

From the repository root:

```bash
pnpm create:tauri my-tool --identifier dev.unimatrix.my-tool
pnpm install
pnpm --filter @unimatrix/my-tool desktop:dev
```

Use `--port 1421` when the default development port is occupied. Pass `--router`
to include TanStack Router. The generated app demonstrates a saved counter using
validated invoke contracts and SQLite. Replace its commands with the application's
operations, retaining the input/result validation and blocking-work boundary.

The generator refuses an existing destination. Its output lives under `apps/`,
so workspace dependencies resolve through pnpm. Run `pnpm install` after generation
and retain both the pnpm lockfile and the app's generated Cargo lockfile.

`desktop:build` compiles the application for the host. Distribution packaging is
an application-level decision; choose and test the desired Tauri bundle target
separately. Test the native binary inside Hyprland: a browser with mocked IPC
checks frontend behavior but cannot prove Rust persistence or Wayland placement.

## Verification

The shared Rust package participates in workspace lint, typecheck, and test tasks;
the generator tests run through `check:ci`. Generated frontend builds and native
builds are separate: run the application's `build`, `lint`, `typecheck`, and
`desktop:build` tasks, then `desktop:check`. The first native build creates
its Cargo lockfile; retain that file before using `desktop:check`, which requires
locked dependencies.

The foundation was checked with Chromium using mocked IPC, including a 360px
viewport and a successful increment without page errors. A generated native
binary was compiled and launched under Hyprland; the compositor reported
`xwayland: false` and its reverse-domain window class. Clicking the counter saved
SQLite data under an isolated XDG override, and restarting then incrementing
recovered the prior value. The embedded frontend also saved a value after the Vite server was stopped.
Distribution bundles require their own acceptance
check when a project selects a packaging target.

When changing command cache updates, exercise a delayed background read that
resolves after a successful save. The generated callback cancels pending reads
before writing the saved value into the cache, so that response cannot restore
stale state.
