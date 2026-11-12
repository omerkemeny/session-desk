"""Kernel change notifications for folders and files (kqueue on macOS and BSD); elsewhere none, and the change feed keeps its timed scan."""
import os
import select

try:
    import resource
except ImportError:  # not on every platform
    resource = None

MAX_FDS = 4096  # watches at most whatever the limit; nothing calls select() on these or the server's sockets, so 1024 is no bound
SHARE = 4  # watches take at most a quarter of the soft descriptor limit
RESERVE = 160  # descriptors always left free for sockets, transcripts, terminal streams and workers; watches get half of what remains
WANT_NOFILE = 16384  # soft descriptor limit asked for (within the hard limit) so the watch share reaches MAX_FDS
NOTE = sum(getattr(select, n, 0) for n in ("KQ_NOTE_WRITE", "KQ_NOTE_EXTEND", "KQ_NOTE_DELETE", "KQ_NOTE_RENAME", "KQ_NOTE_ATTRIB", "KQ_NOTE_REVOKE"))
GONE = sum(getattr(select, n, 0) for n in ("KQ_NOTE_DELETE", "KQ_NOTE_RENAME", "KQ_NOTE_REVOKE"))  # the watched inode left its path
EVTONLY = getattr(os, "O_EVTONLY", 0x8000 if os.uname().sysname == "Darwin" else 0)  # watch without keeping a volume busy
ENABLED = os.environ.get("DESK_WATCH", "1") != "0"  # 0 forces the timed scan (tests, odd file systems)


def available():
    """True where the standard library offers kqueue and watching is not turned off."""
    return ENABLED and hasattr(select, "kqueue")


def room():
    """This process's soft descriptor limit, raised towards WANT_NOFILE when the hard limit allows."""
    if resource is None:
        return 256
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft != resource.RLIM_INFINITY and soft < WANT_NOFILE:
        want = WANT_NOFILE if hard == resource.RLIM_INFINITY else min(WANT_NOFILE, hard)
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
            soft = want
        except (ValueError, OSError):
            pass
    return WANT_NOFILE if soft == resource.RLIM_INFINITY else soft


def open_fds():
    """Descriptors this process has open now (a listing of /dev/fd or /proc/self/fd), or None where neither exists."""
    for d in ("/proc/self/fd", "/dev/fd"):
        try:
            return max(0, len(os.listdir(d)) - 1)  # the listing's own descriptor
        except OSError:
            continue
    return None


def budget(soft):
    """Watches allowed under a soft descriptor limit: a quarter of it and half of what RESERVE leaves, at most MAX_FDS."""
    return max(0, min(MAX_FDS, soft // SHARE, (soft - RESERVE) // 2))


class Watch:
    """A kqueue over a bounded set of paths; `wait` returns the paths that changed."""

    def __init__(self):
        self.kq, self.fds, self.paths = select.kqueue(), {}, {}
        self.limit = room()
        self.cap = budget(self.limit)

    def want(self, paths):
        """Watch these paths (earlier ones first while room lasts) and nothing else; returns the set actually watched.
        Fewer when the process already holds so many descriptors that RESERVE would not stay free."""
        keep, used = set(), open_fds()
        cap = self.cap if used is None else max(0, min(self.cap, len(self.fds) + self.limit - RESERVE - used))
        for p in paths:
            if len(keep) >= cap:
                break
            if p in self.fds or self._add(p):
                keep.add(p)
        for p in [p for p in self.fds if p not in keep]:
            self._drop(p)
        return keep

    def _add(self, path):
        """Open and register one path; False when it cannot be opened."""
        try:
            fd = os.open(path, os.O_RDONLY | EVTONLY | getattr(os, "O_CLOEXEC", 0))
        except OSError:
            return False
        try:
            self.kq.control([select.kevent(fd, select.KQ_FILTER_VNODE, select.KQ_EV_ADD | select.KQ_EV_CLEAR, NOTE)], 0, 0)
        except OSError:
            os.close(fd)
            return False
        self.fds[path], self.paths[fd] = fd, path
        return True

    def _drop(self, path):
        """Stop watching one path (closing its descriptor removes the registration)."""
        fd = self.fds.pop(path, None)
        if fd is not None:
            self.paths.pop(fd, None)
            os.close(fd)

    def wait(self, timeout):
        """Block up to timeout seconds for changes; returns the changed paths (empty on timeout); a path whose inode left is forgotten."""
        try:
            evs = self.kq.control(None, 256, timeout)
        except InterruptedError:
            return set()
        out = set()
        for e in evs:
            p = self.paths.get(e.ident)
            if p is None:
                continue
            out.add(p)
            if e.fflags & GONE:
                self._drop(p)  # re-added by the next `want` when the path exists again
        return out

    def close(self):
        """Release every descriptor and the queue."""
        for p in list(self.fds):
            self._drop(p)
        self.kq.close()
