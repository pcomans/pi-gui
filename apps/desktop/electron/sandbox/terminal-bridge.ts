/** Linux PTY over a JSON control pipe; the SDK's stdin is a pipe, so bash alone cannot host xterm. */
export const TERMINAL_BRIDGE = String.raw`
import base64, fcntl, json, os, pty, select, signal, struct, sys, termios
pid, master = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvpe("/bin/bash", ["bash", "--noprofile", "--norc", "-i"], os.environ)

def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def descendants(parent):
    try:
        with open("/proc/%d/task/%d/children" % (parent, parent)) as children:
            ids = [int(value) for value in children.read().split()]
        return [child for value in ids for child in descendants(value)] + ids
    except (OSError, ValueError):
        return []

def cleanup(*args):
    for child in descendants(pid) + [pid]:
        try: os.kill(child, signal.SIGKILL)
        except ProcessLookupError: pass
    os._exit(0)

signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGHUP, cleanup)
resize(int(sys.argv[1]), int(sys.argv[2]))
pending = b""
try:
    while True:
        ready, _, _ = select.select([0, master], [], [])
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if 0 in ready:
            data = os.read(0, 65536)
            if not data: break
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                request = json.loads(line)
                if "data" in request:
                    data = base64.b64decode(request["data"])
                    while data:
                        count = os.write(master, data)
                        data = data[count:]
                else: resize(request["cols"], request["rows"])
finally:
    cleanup()
`;
