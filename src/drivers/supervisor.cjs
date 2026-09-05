// Runs under plain Node without project loaders. This process anchors the owned
// group until the backend exits or its owner's private IPC connection dies.
const { spawn } = require("node:child_process");

function terminateGroup() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
}

process.on("disconnect", terminateGroup);

let stopping = false;

process.on("SIGTERM", () => {
  if (stopping) {
    return;
  }

  stopping = true;
  setTimeout(terminateGroup, 1000);
});

if (!process.connected) {
  terminateGroup();
}

const [binary, ...argv] = process.argv.slice(2);

// Inherit vendor streams directly; the IPC channel belongs only to the owner.
const backend = spawn(binary, argv, { stdio: [0, 1, 2], detached: false });

let finished = false;

function reportExit(code, signal, error) {
  if (finished) {
    return;
  }

  finished = true;
  if (!process.connected) {
    terminateGroup();

    return;
  }

  process.send({ type: "backend-exit", code, signal, error }, terminateGroup);
}

backend.once("error", (error) => reportExit(1, null, error.message));

backend.once("exit", (code, signal) => reportExit(code, signal));
