#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void sleep_milliseconds(long milliseconds) {
  struct timespec delay = {
      .tv_sec = milliseconds / 1000,
      .tv_nsec = (milliseconds % 1000) * 1000000,
  };
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {
  }
}

static int parse_long(const char *value, long *result) {
  char *end = NULL;
  errno = 0;
  const long parsed = strtol(value, &end, 0);
  if (errno != 0 || end == value || *end != '\0') return 0;
  *result = parsed;
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 7) {
    fputs(
        "usage: astra-x11-keypress DISPLAY WINDOW INTERVAL_MS SETTLE_MS HOLD_MS KEY...\n",
        stderr);
    return 2;
  }

  long window_value = 0;
  long interval_ms = 0;
  long settle_ms = 0;
  long hold_ms = 0;
  if (!parse_long(argv[2], &window_value) || window_value <= 0 ||
      !parse_long(argv[3], &interval_ms) || interval_ms < 0 ||
      !parse_long(argv[4], &settle_ms) || settle_ms < 0 ||
      !parse_long(argv[5], &hold_ms) || hold_ms < 1) {
    fputs("astra-x11-keypress: invalid numeric argument\n", stderr);
    return 2;
  }

  Display *display = XOpenDisplay(argv[1]);
  if (display == NULL) {
    fprintf(stderr, "astra-x11-keypress: cannot open DISPLAY %s\n", argv[1]);
    return 1;
  }

  const Window window = (Window)window_value;
  XRaiseWindow(display, window);
  XSetInputFocus(display, window, RevertToPointerRoot, CurrentTime);
  XSync(display, False);

  for (int index = 6; index < argc; index++) {
    const KeySym symbol = XStringToKeysym(argv[index]);
    const KeyCode code = symbol == NoSymbol ? 0 : XKeysymToKeycode(display, symbol);
    if (code == 0) {
      fprintf(stderr, "astra-x11-keypress: unknown key %s\n", argv[index]);
      XCloseDisplay(display);
      return 2;
    }
    XTestFakeKeyEvent(display, code, True, CurrentTime);
    XFlush(display);
    sleep_milliseconds(hold_ms);
    XTestFakeKeyEvent(display, code, False, CurrentTime);
    XFlush(display);
    if (index + 1 < argc && interval_ms > 0) sleep_milliseconds(interval_ms);
  }

  if (settle_ms > 0) sleep_milliseconds(settle_ms);
  XCloseDisplay(display);
  return 0;
}
