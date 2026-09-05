// Runs under plain Node, without project loaders. Its live process-group leader
// anchors ownership until the backend exits or the owner's IPC connection dies.
// Keep vendor stdin/stdout/stderr inherited so streams need no proxy buffering.
export const supervisorSource = String.raw`
const { spawn } = require("node:child_process");
const terminate = () => {
  try { process.kill(-process.pid, "SIGKILL"); }
  catch { process.exit(1); }
};
process.on("disconnect", terminate);
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  setTimeout(terminate, 1000);
});
if (!process.connected) terminate();
const [binary, ...argv] = process.argv.slice(1);
const child = spawn(binary, argv, { stdio: [0, 1, 2], detached: false });
let finished = false;
const finish = (code, signal, error) => {
  if (finished) return;
  finished = true;
  if (!process.connected) return terminate();
  process.send({ type: "backend-exit", code, signal, error }, terminate);
};
child.once("error", error => finish(1, null, error.message));
child.once("exit", (code, signal) => finish(code, signal));
`;
