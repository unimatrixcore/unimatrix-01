/* Read exact, lifetime-scoped window identifiers from the compositor. No pixels.
 * Two registry roundtrips give a complete ext-foreign-toplevel initial snapshot.
 */
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "ext-foreign-toplevel-list-v1-client-protocol.h"

#define MAX_WINDOWS 2048
struct window { struct ext_foreign_toplevel_handle_v1 *handle; char *identifier, *title, *app_id; bool closed, done; };
struct state { struct ext_foreign_toplevel_list_v1 *list; struct window windows[MAX_WINDOWS]; size_t count; bool image_copy, toplevel_source, finished; };
static void replace(char **target, const char *value) { free(*target); *target = strndup(value, 8192); }
static void closed(void *data, struct ext_foreign_toplevel_handle_v1 *handle) { (void)handle; ((struct window *)data)->closed = true; }
static void done(void *data, struct ext_foreign_toplevel_handle_v1 *handle) { (void)handle; ((struct window *)data)->done = true; }
static void title(void *data, struct ext_foreign_toplevel_handle_v1 *handle, const char *value) { (void)handle; replace(&((struct window *)data)->title, value); }
static void app_id(void *data, struct ext_foreign_toplevel_handle_v1 *handle, const char *value) { (void)handle; replace(&((struct window *)data)->app_id, value); }
static void identifier(void *data, struct ext_foreign_toplevel_handle_v1 *handle, const char *value) { (void)handle; replace(&((struct window *)data)->identifier, value); }
static const struct ext_foreign_toplevel_handle_v1_listener handle_listener = { .closed=closed, .done=done, .title=title, .app_id=app_id, .identifier=identifier };
static void toplevel(void *data, struct ext_foreign_toplevel_list_v1 *list, struct ext_foreign_toplevel_handle_v1 *handle) {
    (void)list; struct state *s=data;
    if (s->count == MAX_WINDOWS) { ext_foreign_toplevel_handle_v1_destroy(handle); return; }
    struct window *window=&s->windows[s->count++]; window->handle=handle;
    ext_foreign_toplevel_handle_v1_add_listener(handle, &handle_listener, window);
}
static void finished(void *data, struct ext_foreign_toplevel_list_v1 *list) { (void)list; ((struct state *)data)->finished=true; }
static const struct ext_foreign_toplevel_list_v1_listener list_listener = { .toplevel=toplevel, .finished=finished };
static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    (void)version; struct state *s=data;
    if (!strcmp(interface,"ext_foreign_toplevel_list_v1") && !s->list) {
        s->list=wl_registry_bind(registry,name,&ext_foreign_toplevel_list_v1_interface,1);
        ext_foreign_toplevel_list_v1_add_listener(s->list,&list_listener,s);
    } else if (!strcmp(interface,"ext_image_copy_capture_manager_v1")) s->image_copy=true;
    else if (!strcmp(interface,"ext_foreign_toplevel_image_capture_source_manager_v1")) s->toplevel_source=true;
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name) { (void)data; (void)registry; (void)name; }
static const struct wl_registry_listener registry_listener = { .global=global, .global_remove=global_remove };
static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *p=(const unsigned char *)(value ? value : ""); *p; ++p) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 0x20) printf("\\u%04x",*p);
        else putchar(*p);
    }
    putchar('"');
}
int main(void) {
    struct state s={0}; struct wl_display *display=wl_display_connect(NULL);
    if (!display) { fputs("Cannot connect to the Wayland compositor\n",stderr); return 1; }
    struct wl_registry *registry=wl_display_get_registry(display);
    wl_registry_add_listener(registry,&registry_listener,&s);
    if (wl_display_roundtrip(display)<0 || wl_display_roundtrip(display)<0) { fputs("Wayland window inventory failed\n",stderr); wl_display_disconnect(display); return 1; }
    printf("{\"capabilities\":{\"toplevel\":%s,\"image_copy\":%s,\"toplevel_source\":%s},\"windows\":[",s.list && !s.finished ? "true":"false",s.image_copy ? "true":"false",s.toplevel_source ? "true":"false");
    bool comma=false;
    for (size_t i=0;i<s.count;++i) {
        struct window *w=&s.windows[i];
        if (w->closed || !w->done || !w->identifier || !*w->identifier) continue;
        if (comma) putchar(','); comma=true;
        fputs("{\"identifier\":",stdout); json_string(w->identifier);
        fputs(",\"title\":",stdout); json_string(w->title);
        fputs(",\"app_id\":",stdout); json_string(w->app_id); putchar('}');
    }
    puts("]}");
    for (size_t i=0;i<s.count;++i) { ext_foreign_toplevel_handle_v1_destroy(s.windows[i].handle); free(s.windows[i].identifier); free(s.windows[i].title); free(s.windows[i].app_id); }
    if (s.list) ext_foreign_toplevel_list_v1_destroy(s.list);
    wl_registry_destroy(registry); wl_display_disconnect(display); return 0;
}
