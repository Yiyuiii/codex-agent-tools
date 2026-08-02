import { createConnection } from "node:net";

if (process.argv.length !== 3 || !process.argv[2].startsWith("\\\\.\\pipe\\codex-agent-tools-host-acceptance-")) {
  process.exitCode = 64;
} else {
  const socket = createConnection(process.argv[2]);
  socket.once("connect", () => {
    socket.end(Buffer.from("terminal\n", "utf8"));
  });
  socket.once("error", () => {
    process.exitCode = 65;
  });
}
