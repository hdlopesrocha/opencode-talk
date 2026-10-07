#!/usr/bin/env python3
"""Put stdin text on the X11 clipboard and keep ownership for a while.

Used by the opencode-voice plugin so `/mic submit` can place the transcript on
the clipboard (paste it with Ctrl+V, edit, then send). No external tools needed.

Keeps running so the selection is served; exits after OPENCODE_VOICE_CLIP_TTL
milliseconds (default 180000).
"""

import os
import sys


def main() -> int:
    text = sys.stdin.read()
    if not text.strip():
        return 0
    try:
        import tkinter
    except Exception as error:  # pragma: no cover
        print(f"tkinter unavailable: {error}", file=sys.stderr)
        return 2
    try:
        root = tkinter.Tk()
        root.withdraw()
        root.clipboard_clear()
        root.clipboard_append(text)
        root.update()
        ttl = int(os.environ.get("OPENCODE_VOICE_CLIP_TTL", "180000"))
        root.after(ttl, root.destroy)
        root.mainloop()
    except Exception as error:  # pragma: no cover
        print(f"clipboard failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
