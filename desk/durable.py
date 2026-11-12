"""Crash-safe small files: one writer at a time per folder (flock on the folder), synced temp file in the same folder, rename, folder sync; never reloaded."""
import fcntl
import glob
import os
import threading

_lock = threading.Lock()  # one writer at a time inside this process; the folder lock covers other processes


def temp_name(path):
    """Temp file beside path, named by writer process and thread so a stale one can be traced to a dead writer."""
    return f"{path}.{os.getpid()}-{threading.get_ident()}.tmp"


def write(path, data, mode=0o600):
    """Replace path with data atomically: a crash at any point leaves the old file or the new one, whole; raises OSError."""
    tmp, folder = temp_name(path), os.path.dirname(path) or "."
    dfd = os.open(folder, os.O_RDONLY)
    try:
        with _lock:
            fcntl.flock(dfd, fcntl.LOCK_EX)  # the folder itself is the lock: no lock file to leave behind
            drop_stale_temps(path)  # a writer killed mid-write left its temp file (possibly private text): the next writer removes it
            _replace(path, tmp, data, mode)
            try:
                os.fsync(dfd)  # the rename itself reaches the disk; some file systems refuse this
            except OSError:
                pass
    finally:
        os.close(dfd)


def _replace(path, tmp, data, mode):
    """Synced temp file renamed over path; the temp file is removed on any failure."""
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def drop_stale_temps(path):
    """Remove temp files of path left by writers that were killed mid-write (their process is gone); returns how many were removed."""
    n = 0
    for tmp in glob.glob(glob.escape(path) + ".*.tmp"):
        try:
            pid = int(tmp[len(path) + 1:].split("-", 1)[0].split(".", 1)[0])
            if pid != os.getpid():
                os.kill(pid, 0)
            continue
        except ProcessLookupError:
            pass
        except (ValueError, OSError):
            continue
        try:
            os.remove(tmp)
            n += 1
        except OSError:
            pass
    return n
